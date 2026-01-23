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
    log('info', '[DOMAIN][ENTER]', {
        domain: 'quintero',
        phase: 'START_GREETING',
        turn: ctx.turn || 0,
        businessState: {
            identificador: state.identificador
        }
    });

    // 🛡️ Pre-Playback Delay: Removed to improve latency
    // await new Promise(resolve => setTimeout(resolve, 500));

    const response = {
        audio: 'quintero/greeting_sofia_2',
        ttsText: null, // Ensure no TTS
        nextPhase: 'WAIT_RUT', // ✅ Transition to explicit Listening phase (Unified RUT)
        silent: true, // 🔒 Disable listening during playback
        allowBargeIn: false,
        shouldHangup: false,
        action: 'PLAY_AUDIO',
        config: {
            listenTimeout: 8000 // ⏳ Give 8s for the user to start speaking their RUT 
        }
    };

    log('info', '[DOMAIN][RESPONSE]', response);
    return response;
}
