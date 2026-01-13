/**
 * 🎯 Handler para fase OFFER_ALTERNATIVES_WAIT
 * Espera respuesta del usuario después del TTS inicial
 */

import { log } from '../../../../../lib/logger.js';
import * as tts from '../tts/messages.js';

/**
 * Maneja la fase OFFER_ALTERNATIVES_WAIT
 * @param {object} ctx - Contexto de la sesión
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function offerAlternativesWait(ctx, state) {
    const { transcript } = ctx;

    // Si no hay transcript, es silencio
    if (!transcript || transcript.trim().length === 0) {
        log("info", `[OFFER_ALTERNATIVES_WAIT] Silencio detectado (intento ${state.alternativesAttempts})`);
        return {
            ttsText: null,
            nextPhase: 'OFFER_ALTERNATIVES_WAIT',
            silent: false,
            action: {
                type: "SET_STATE",
                payload: {
                    updates: {}
                }
            }
        };
    }

    const clean = transcript.toLowerCase().trim();
    log("info", `[OFFER_ALTERNATIVES_WAIT] Analizando respuesta: "${clean}"`);

    // 1. SI / OTRA ESPECIALIDAD -> ASK_SPECIALTY
    if (/^(s[íi]|bueno|ok|claro|ya|otra|consultar|ver|buscar)/i.test(clean)) {
        log("info", `✅ [OFFER_ALTERNATIVES_WAIT] Usuario acepta buscar otra especialidad`);
        return {
            ttsText: "De acuerdo. ¿Para qué especialidad médica necesita agendar su hora?",
            nextPhase: 'ASK_SPECIALTY',
            shouldHangup: false,
            action: {
                type: "SET_STATE",
                payload: {
                    updates: {
                        rutPhase: 'ASK_SPECIALTY',
                        specialtyAttempts: 0,
                        dateAttempts: 0
                    }
                }
            }
        };
    }

    // 2. OTRO RUT / CAMBIAR PERSONA -> DENEGAR
    if (/(otro\s+rut|otra\s+persona|otrx\s+paciente|cambiar|diferente|no\s+soy\s+yo)/i.test(clean)) {
        log("warn", `🚫 [OFFER_ALTERNATIVES_WAIT] Usuario intenta cambiar RUT: Denegado`);
        return {
            ttsText: tts.denyRutChange(),
            nextPhase: 'COMPLETE',
            shouldHangup: true,
            action: {
                type: "END_CALL",
                payload: {
                    reason: "SECURITY_RUT_CHANGE_ATTEMPT",
                    ttsText: tts.denyRutChange()
                }
            }
        };
    }

    // 3. NO / DESPEDIDA → GOODBYE (reproduce despedida antes de colgar)
    if (/^(no|gracias|chao|eso\s+es\s+todo|nada|ninguna)/i.test(clean)) {
        log("info", `👋 [OFFER_ALTERNATIVES_WAIT] Usuario declina. Transicionando a GOODBYE.`);
        return {
            ttsText: null,  // GOODBYE manejará el TTS
            nextPhase: 'GOODBYE',
            shouldHangup: false,
            silent: true,  // Transición silenciosa
            action: {
                type: "SET_STATE",
                payload: {
                    updates: {
                        rutPhase: 'GOODBYE'
                    }
                }
            }
        };
    }

    // 4. NO ENTENDIDO -> Reintentar
    state.alternativesAttempts = (state.alternativesAttempts || 0) + 1;
    if (state.alternativesAttempts >= 2) {
        log("warn", `[OFFER_ALTERNATIVES_WAIT] Máximos reintentos excedidos. Transicionando a GOODBYE.`);
        return {
            ttsText: null,
            nextPhase: 'GOODBYE',
            shouldHangup: false,
            silent: true
        };
    }

    return {
        ttsText: "No le entendí bien. ¿Desea consultar por otra especialidad? Dígame sí o no.",
        nextPhase: 'OFFER_ALTERNATIVES_WAIT',
        shouldHangup: false
    };
}
