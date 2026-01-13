/**
 * GoodbyePolicy - Manages graceful call termination
 * 
 * Purpose: Isolate goodbye detection and hangup logic to ensure
 * clean call termination without post-hangup errors.
 * 
 * Governance: CORE module - no client-specific logic
 */

import { log } from '../../../../lib/logger.js';

export class TerminationPolicy {
    constructor(config = {}) {
        // Default goodbye phrases (can be overridden per-client)
        this.goodbyePhrases = config.goodbyePhrases || [
            'que tenga un excelente día',
            'que tenga un buen día',
            'hasta luego',
            'adiós',
            'me despido',
            'un gusto haberle ayudado',
            'nos vemos',
            'finalizar llamada',
            'que esté bien',
            'cuídese'
        ];

        this.postAudioDelayMs = config.postAudioDelayMs || 2000; // Wait 2s after final audio
    }

    /**
     * Detect if assistant response contains goodbye phrase
     * 
     * @param {string} assistantResponse - Text from assistant
     * @returns {boolean}
     */
    shouldEnd(assistantResponse) {
        if (!assistantResponse) {
            return false;
        }

        const lowerText = assistantResponse.toLowerCase();
        const detected = this.goodbyePhrases.some(phrase => lowerText.includes(phrase));

        if (detected) {
            log('info', `👋 [GOODBYE] Detected in: "${assistantResponse.substring(0, 50)}..."`);
        }

        return detected;
    }

    /**
     * Execute graceful call termination
     * 
     * @param {SessionContext} session
     * @param {ChannelControl} channelControl
     * @param {PlaybackModule} playbackModule - Optional, for final message
     * @param {string} finalMessage - Optional final TTS text
     */
    async finalize(session, channelControl, playbackModule = null, finalMessage = null) {
        log('info', `👋 [GOODBYE] Initiating graceful termination for ${session.linkedId}`);

        // Mark session as terminated early to prevent new operations
        session.terminate();

        // Play final message if provided
        if (finalMessage && playbackModule) {
            try {
                log('info', `🔊 [GOODBYE] Playing final message: "${finalMessage}"`);
                await playbackModule.playFinalMessage(finalMessage);
            } catch (err) {
                log('warn', `⚠️ [GOODBYE] Failed to play final message: ${err.message}`);
            }
        }

        // Wait for audio to complete
        log('debug', `⏱️ [GOODBYE] Waiting ${this.postAudioDelayMs}ms for audio completion`);
        await new Promise(resolve => setTimeout(resolve, this.postAudioDelayMs));

        // Hangup channel
        try {
            await channelControl.hangup();
            log('info', `✅ [GOODBYE] Call terminated successfully: ${session.linkedId}`);
        } catch (err) {
            // Benign error - channel may already be down
            log('debug', `🔇 [GOODBYE] Hangup skipped (channel already down): ${err.message}`);
        }
    }

    /**
     * Quick termination without final message (for errors/timeouts)
     * 
     * @param {SessionContext} session
     * @param {ChannelControl} channelControl
     * @param {string} reason - Termination reason for logging
     */
    async terminate(session, channelControl, reason = 'unknown') {
        log('warn', `⚠️ [GOODBYE] Quick termination: ${reason}`);

        session.terminate();

        try {
            await channelControl.hangup();
        } catch (err) {
            log('debug', `🔇 [GOODBYE] Hangup failed: ${err.message}`);
        }
    }

    /**
     * Add custom goodbye phrase (for client-specific extensions)
     */
    addGoodbyePhrase(phrase) {
        if (!this.goodbyePhrases.includes(phrase.toLowerCase())) {
            this.goodbyePhrases.push(phrase.toLowerCase());
            log('debug', `[GOODBYE] Added custom phrase: "${phrase}"`);
        }
    }
}
