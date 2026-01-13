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
        audio: 'quintero/greeting_sofia_2',
        ttsText: null, // Ensure no TTS
        nextPhase: 'WAIT_RUT_INPUT', // ✅ Correct Phase for RUT Domain v2
        silent: true, // 🔒 Disable listening during playback
        allowBargeIn: false,
        shouldHangup: false,
        action: 'PLAY_AUDIO'
    };
}
