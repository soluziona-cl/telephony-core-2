/**
 * PlaybackModule - Manages audio playback with barge-in detection
 * 
 * Purpose: Isolate all playback logic including barge-in detection,
 * timeout handling, and OpenAI integration.
 * 
 * Governance: CORE module - no client-specific logic
 */

import { log } from '../../../../lib/logger.js';

export class PlaybackModule {
    constructor(ari, config = {}) {
        this.ari = ari;
        this.playbackTimeoutMs = config.playbackTimeoutMs || 30000;
        this.talkingDebounceMs = config.talkingDebounceMs || 300;
        this.voicebotPath = config.voicebotPath || '/var/lib/asterisk/sounds/voicebot';
    }

    /**
     * Play audio file with barge-in detection
     * 
     * @param {Object} channel - ARI channel
     * @param {string} fileBaseName - Audio file basename (without path/extension)
     * @param {Object} openaiClient - OpenAI client for cancellation
     * @param {Object} options - { bargeIn: boolean }
     * @returns {Promise<Object>} - { reason: 'finished' | 'barge-in' | 'stopped' | 'failed' | 'channel_down' }
     */
    async playWithBargeIn(channel, fileBaseName, openaiClient = null, options = {}) {
        // 🛡️ Protection: Verify channel exists before playback
        try {
            const channelState = await channel.get();
            if (!channelState || channelState.state === 'Down') {
                log('debug', `🔇 [PLAYBACK] Channel not available (state: ${channelState?.state || 'null'}), skipping`);
                if (openaiClient) openaiClient.isPlaybackActive = false;
                return { reason: 'channel_down' };
            }
        } catch (err) {
            log('debug', `🔇 [PLAYBACK] Cannot verify channel state: ${err.message}, skipping`);
            if (openaiClient) openaiClient.isPlaybackActive = false;
            return { reason: 'channel_not_found' };
        }

        const allowBargeIn = options.bargeIn !== false;
        const media = `sound:voicebot/${fileBaseName}`;
        const playback = this.ari.Playback();

        log('info', `🔊 [PLAYBACK] Playing (barge-in ${allowBargeIn ? 'enabled' : 'disabled'}): ${media}`);
        if (openaiClient) openaiClient.isPlaybackActive = true;

        return new Promise((resolve) => {
            let bargedIn = false;
            let finished = false;
            let talkingTimer = null;
            const startedAt = Date.now();

            const talkingHandler = (event, chan) => {
                if (!chan || chan.id !== channel.id) return;
                if (finished || !allowBargeIn) return;

                if (talkingTimer) clearTimeout(talkingTimer);

                talkingTimer = setTimeout(() => {
                    if (finished) return;

                    log('info', `🗣️ [PLAYBACK] 🔥 BARGE-IN detected → User interrupted`);
                    bargedIn = true;

                    // Cancel OpenAI response if active
                    if (openaiClient && openaiClient.activeResponseId) {
                        openaiClient.cancelCurrentResponse('user_barge_in');
                    }

                    playback.stop().catch((err) =>
                        log('warn', `⚠️ [PLAYBACK] Error stopping playback: ${err.message}`)
                    );
                }, this.talkingDebounceMs);
            };

            const cleanup = () => {
                finished = true;
                if (talkingTimer) clearTimeout(talkingTimer);
                channel.removeListener('ChannelTalkingStarted', talkingHandler);
            };

            channel.on('ChannelTalkingStarted', talkingHandler);

            playback.on('PlaybackFinished', () => {
                if (finished) return;
                if (openaiClient) openaiClient.isPlaybackActive = false;
                log('debug', `✅ [PLAYBACK] Completed: ${media}`);
                cleanup();
                resolve({ reason: bargedIn ? 'barge-in' : 'finished' });
            });

            playback.on('PlaybackStopped', () => {
                if (finished) return;
                if (openaiClient) openaiClient.isPlaybackActive = false;
                log('debug', `🛑 [PLAYBACK] Stopped: ${media}`);
                cleanup();
                resolve({ reason: bargedIn ? 'barge-in' : 'stopped' });
            });

            playback.on('PlaybackFailed', (evt) => {
                if (finished) return;
                if (openaiClient) openaiClient.isPlaybackActive = false;
                log('error', `❌ [PLAYBACK] Failed: ${JSON.stringify(evt)}`);
                cleanup();
                resolve({ reason: 'failed' });
            });

            // Timeout protection
            const timeoutTimer = setInterval(() => {
                if (finished) {
                    clearInterval(timeoutTimer);
                    return;
                }
                if (Date.now() - startedAt > this.playbackTimeoutMs) {
                    log('warn', `⏰ [PLAYBACK] Timeout: ${media}`);
                    playback.stop().catch((err) =>
                        log('warn', `⚠️ [PLAYBACK] Error on timeout: ${err.message}`)
                    );
                    clearInterval(timeoutTimer);
                }
            }, 500);

            // Start playback
            channel
                .play({ media }, playback)
                .catch((err) => {
                    if (finished) return;
                    log('error', `❌ [PLAYBACK] Cannot start: ${err.message}`);
                    cleanup();
                    resolve({ reason: 'error' });
                });
        });
    }

    /**
     * Play final message (non-interruptible) for goodbye
     * 
     * @param {Object} channel
     * @param {string} fileBaseName
     * @param {Object} openaiClient
     * @returns {Promise<Object>}
     */
    async playFinalMessage(channel, fileBaseName, openaiClient = null) {
        log('info', `🛡️ [PLAYBACK] Playing final message (non-interruptible): ${fileBaseName}`);
        return this.playWithBargeIn(channel, fileBaseName, openaiClient, { bargeIn: false });
    }

    /**
     * Play static audio file (simple, no barge-in)
     * 
     * @param {Object} channel
     * @param {string} fileBaseName
     * @returns {Promise<boolean>}
     */
    async playStatic(channel, fileBaseName) {
        try {
            const media = `sound:voicebot/${fileBaseName}`;
            await channel.play({ media });
            log('info', `🔊 [PLAYBACK] Static audio played: ${media}`);
            return true;
        } catch (err) {
            log('error', `❌ [PLAYBACK] Static playback failed: ${err.message}`);
            return false;
        }
    }
}
