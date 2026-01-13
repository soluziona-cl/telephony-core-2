/**
 * 🎯 Handler para fase OFFER_ALTERNATIVES_INTRO
 * Reproduce TTS inicial sin esperar input (Turn 0 de alternativas)
 */

import { log } from '../../../../../lib/logger.js';
import * as tts from '../tts/messages.js';

/**
 * Maneja la fase OFFER_ALTERNATIVES_INTRO
 * @param {object} ctx - Contexto de la sesión
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function offerAlternativesIntro(ctx, state) {
    log("info", `[OFFER_ALTERNATIVES_INTRO] Reproduciendo TTS inicial`);

    return {
        ttsText: tts.offerAnotherSpecialty(),
        nextPhase: 'OFFER_ALTERNATIVES_WAIT',
        shouldHangup: false,
        skipUserInput: true,  // No esperar input, solo hablar
        action: {
            type: "SET_STATE",
            payload: {
                updates: {
                    rutPhase: 'OFFER_ALTERNATIVES_WAIT',
                    alternativesAttempts: 1
                }
            }
        }
    };
}
