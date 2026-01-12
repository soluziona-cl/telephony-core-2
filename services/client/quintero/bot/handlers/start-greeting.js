/**
 * 📢 Handler para fase START_GREETING (Turno 0)
 * Reproduce el saludo inicial explícito y transiciona a WAIT_BODY.
 * NO escucha input, solo reproduce.
 */

import { log } from '../../../../../lib/logger.js';

/**
 * Maneja la fase START_GREETING
 * @param {object} ctx - Contexto de la sesión
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Instrucción para el engine
 */
export default async function startGreeting(ctx, state) {
    log("info", "📢 [START_GREETING] Ejecutando Turno 0 explícito");

    return {
        ttsText: "sound:voicebot/greeting_sofia_2", // Audio estático fijo
        nextPhase: 'WAIT_BODY',
        shouldHangup: false,
        action: {
            type: 'PLAY_SOUND', // Instrucción semántica para el engine (si lo soporta) o metadata
            payload: {
                soundId: 'greeting_sofia_2'
            }
        }
    };
}
