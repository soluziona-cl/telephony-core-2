/**
 * 🎯 Handler para fase OFFER_ALTERNATIVES
 * Pregunta al usuario si desea buscar otra especialidad tras no encontrar disponibilidad
 */

import { log } from '../../../../../../lib/logger.js';
import * as tts from '../tts/messages.js';

/**
 * Maneja la fase OFFER_ALTERNATIVES
 * @param {object} ctx - Contexto de la sesión
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function offerAlternatives(ctx, state) {
    const { transcript } = ctx;

    // Si no hay transcript (primera vez o silencio), esperar input
    // Si no hay transcript (primera vez tras transición silenciosa), esperar input
    if (!transcript) {
        log("info", `[OFFER_ALTERNATIVES] Turno 2 (Escucha): Iniciando espera de voz`);
        return {
            ttsText: null, // Ya se dijo el TTS en Turno 1
            nextPhase: 'OFFER_ALTERNATIVES',
            silent: false, // 🎤 Engine escucha
            action: {
                type: "SET_STATE",
                payload: {
                    updates: {} // No updates needed
                }
            }
        };
    }

    const clean = transcript.toLowerCase().trim();
    log("info", `[OFFER_ALTERNATIVES] Analizando respuesta: "${clean}"`);

    // 1. SI / OTRA ESPECIALIDAD -> ASK_SPECIALTY
    // Patterns: "sí", "bueno", "otra", "otra especialidad", "ok"
    if (/^(s[íi]|bueno|ok|claro|ya|otra|consultar|ver|buscar)/i.test(clean)) {
        log("info", `✅ [OFFER_ALTERNATIVES] Usuario acepta buscar otra especialidad`);
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
                        // Mantenemos: rutBody, rutDv, patient, etc.
                    }
                }
            }
        };
    }

    // 2. OTRO RUT / CAMBIAR PERSONA -> DENEGAR
    // Patterns: "otro rut", "otra persona", "mi hermano", "mi hijo", "cambiar rut"
    if (/(otro\s+rut|otra\s+persona|otrx\s+paciente|cambiar|diferente|no\s+soy\s+yo)/i.test(clean)) {
        log("warn", `🚫 [OFFER_ALTERNATIVES] Usuario intenta cambiar RUT: Denegado`);
        return {
            ttsText: tts.denyRutChange(),
            nextPhase: 'COMPLETE',
            shouldHangup: true,
            action: {
                type: "END_CALL", // Finalizar llamada por seguridad
                payload: {
                    reason: "SECURITY_RUT_CHANGE_ATTEMPT",
                    ttsText: tts.denyRutChange()
                }
            }
        };
    }

    // 3. NO / DESPEDIDA -> FIN
    // Patterns: "no", "gracias", "chao", "hasta luego", "nada"
    if (/^(no|gracias|chao|eso\s+es\s+todo|nada|ninguna)/i.test(clean)) {
        log("info", `👋 [OFFER_ALTERNATIVES] Usuario declina. Finalizando.`);
        return {
            ttsText: tts.farewell(),
            nextPhase: 'COMPLETE',
            shouldHangup: true,
            action: {
                type: "END_CALL",
                payload: {
                    reason: "USER_DECLINED_RETRY",
                    ttsText: tts.farewell()
                }
            }
        };
    }

    // 4. NO ENTENDIDO -> Reintentar una vez y luego cortar? 
    // Por simplicidad, asumimos NO si no lo entendemos tras N intentos o simplemente repetimos la pregunta.
    // Vamos a repetir la pregunta si no entendemos.

    state.alternativesAttempts = (state.alternativesAttempts || 0) + 1;
    if (state.alternativesAttempts >= 2) {
        log("warn", `[OFFER_ALTERNATIVES] Máximos reintentos excedidos. Finalizando.`);
        return {
            ttsText: tts.farewell(),
            nextPhase: 'COMPLETE',
            shouldHangup: true
        };
    }

    return {
        ttsText: "No le entendí bien. ¿Desea consultar por otra especialidad? Dígame sí o no.",
        nextPhase: 'OFFER_ALTERNATIVES',
        shouldHangup: false
    };
}
