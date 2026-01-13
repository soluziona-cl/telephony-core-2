/**
 * 🎯 Handler para fase GOODBYE
 * Reproduce despedida antes de finalizar la llamada
 */

import { log } from '../../../../../lib/logger.js';

/**
 * Maneja la fase GOODBYE
 * @param {object} ctx - Contexto de la sesión
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function goodbye(ctx, state) {
    log("info", `👋 [GOODBYE] Reproduciendo despedida final`);

    return {
        ttsText: "sound:voicebot/quintero/farewell",  // Audio estático directo
        nextPhase: 'COMPLETE',
        shouldHangup: false,  // Aún no colgar, primero hablar
        skipUserInput: true,  // No esperar input, solo reproducir
        action: {
            type: "SET_STATE",
            payload: {
                updates: {
                    rutPhase: 'COMPLETE'
                }
            }
        }
    };
}
