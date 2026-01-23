/**
 * PlaybackModule - Manages audio playback with barge-in detection
 * 
 * Purpose: Isolate all playback logic including barge-in detection,
 * timeout handling, and OpenAI integration.
 * 
 * Governance: CORE module - no client-specific logic
 */

import { log } from '../../../../lib/logger.js';
import { shouldInterrupt } from '../contracts/interrupt-policy.contract.js';

export class PlaybackModule {
    constructor(ari, config = {}) {
        this.ari = ari;
        this.playbackTimeoutMs = config.playbackTimeoutMs || 30000;
        // 🎯 MEJORA FLUIDEZ: Barge-in más rápido (< 150ms objetivo)
        // Reducido de 300ms a 100ms para detección más rápida, con mínimo de 50ms para evitar falsos positivos
        this.talkingDebounceMs = config.talkingDebounceMs || 100;
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

        // ✅ ARQUITECTURA DESACOPLADA: Usar interruptPolicy si está disponible
        const interruptPolicy = options.interruptPolicy || {
            allowBargeIn: options.bargeIn !== false,
            minSpeechMs: 400,
            minConfidence: 0.6,
            ignoreIfOnlyNoise: true
        };
        const allowBargeIn = interruptPolicy.allowBargeIn;
        
        const media = `sound:voicebot/${fileBaseName}`;
        const playback = this.ari.Playback();

        log('info', `🔊 [PLAYBACK] Playing (interruptPolicy: allowBargeIn=${allowBargeIn}, minSpeechMs=${interruptPolicy.minSpeechMs}, minConfidence=${interruptPolicy.minConfidence}): ${media}`);
        if (openaiClient) openaiClient.isPlaybackActive = true;

        return new Promise((resolve) => {
            let bargedIn = false;
            let finished = false;
            let talkingTimer = null;
            let speechStartTime = null;
            const startedAt = Date.now();

            const talkingHandler = (event, chan) => {
                if (!chan || chan.id !== channel.id) return;
                if (finished || !allowBargeIn) return;

                // ✅ ARQUITECTURA DESACOPLADA: Evaluar interrupción por intención
                // Si tenemos datos de STT disponibles, usarlos para evaluación avanzada
                const speechMs = speechStartTime ? Date.now() - speechStartTime : 0;
                if (!speechStartTime) {
                    speechStartTime = Date.now();
                }

                // Obtener datos de STT si están disponibles (desde openaiClient)
                let sttData = null;
                if (openaiClient && openaiClient.lastTranscript) {
                    // Intentar obtener confianza del último transcript (si está disponible)
                    sttData = {
                        text: openaiClient.lastTranscript,
                        confidence: openaiClient.lastTranscriptConfidence || 0.8, // Fallback a confianza media
                        isNoise: false // TODO: Implementar detección de ruido
                    };
                }

                // Evaluar si se debe interrumpir usando interruptPolicy
                const shouldInterruptPlayback = shouldInterrupt(interruptPolicy, {
                    speechMs: speechMs,
                    confidence: sttData?.confidence,
                    text: sttData?.text || '',
                    isNoise: sttData?.isNoise || false
                });

                if (talkingTimer) clearTimeout(talkingTimer);

                // ✅ Evaluación avanzada: Solo interrumpir si la política lo permite
                if (shouldInterruptPlayback) {
                    talkingTimer = setTimeout(() => {
                        if (finished) return;

                        log('info', `🗣️ [PLAYBACK] 🔥 BARGE-IN detected (speechMs=${speechMs}, confidence=${sttData?.confidence || 'N/A'}) → User interrupted`);
                        bargedIn = true;

                        // Cancel OpenAI response if active
                        if (openaiClient && openaiClient.activeResponseId) {
                            openaiClient.cancelCurrentResponse('user_barge_in');
                        }

                        playback.stop().catch((err) =>
                            log('warn', `⚠️ [PLAYBACK] Error stopping playback: ${err.message}`)
                        );
                    }, this.talkingDebounceMs);
                } else if (speechMs < interruptPolicy.minSpeechMs) {
                    // Voz demasiado corta - esperar más
                    log('debug', `🔒 [PLAYBACK] Voz detectada pero demasiado corta (${speechMs}ms < ${interruptPolicy.minSpeechMs}ms) - esperando más`);
                }
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
