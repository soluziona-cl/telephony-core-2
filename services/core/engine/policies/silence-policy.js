/**
 * SilencePolicy - Manages silence detection and fail-closed behavior
 * 
 * Purpose: Isolate silence tracking logic to enable future HOLD feature
 * and maintain fail-closed safety guarantees.
 * 
 * Governance: CORE module - no client-specific logic
 */

import { log } from '../../../../lib/logger.js';

export class SilencePolicy {
    constructor(config = {}) {
        this.maxSilentTurns = config.maxSilentTurns || 3;
        this.failClosedEnabled = config.failClosed !== false; // Default: enabled
    }

    /**
     * Evaluate silence state and determine action
     * 
     * @param {SessionContext} session - Current session
     * @param {boolean} voiceDetected - Whether voice was detected this turn
     * @returns {Object} - { action: 'continue' | 'prompt' | 'goodbye', reason?: string }
     */
    evaluate(session, voiceDetected) {
        if (voiceDetected) {
            session.markVoiceDetected();
            return { action: 'continue' };
        }

        // No voice detected - increment silence
        session.incrementSilence();

        log('info', `🤫 [SILENCE] Consecutive: ${session.consecutiveSilences}/${this.maxSilentTurns}, Total: ${session.silenceCount}`);

        // Check if we've hit the limit
        if (session.consecutiveSilences >= this.maxSilentTurns) {
            if (this.failClosedEnabled) {
                log('warn', `🔒 [FAIL-CLOSED] Max consecutive silences (${this.maxSilentTurns}) reached, ending call`);
                return {
                    action: 'goodbye',
                    reason: 'max_silence',
                    message: 'Parece que no hay respuesta. Hasta luego.'
                };
            } else {
                log('warn', `⚠️ [SILENCE] Max silences reached but fail-closed disabled`);
                return { action: 'continue' };
            }
        }

        // First silence - prompt user
        if (session.consecutiveSilences === 1) {
            return {
                action: 'prompt',
                reason: 'first_silence'
            };
        }

        // Subsequent silences - continue waiting
        return { action: 'continue' };
    }

    /**
     * Check if we should play "still there?" prompt
     */
    shouldPrompt(session) {
        return session.consecutiveSilences === 1;
    }

    /**
     * Reset policy state (called when voice detected)
     */
    reset(session) {
        session.resetSilence();
    }
}
