/**
 * 🎯 Handler para fase ASK_SPECIALTY
 * Pregunta al usuario qué especialidad médica necesita
 * Implementa política progresiva de silencios (3 intentos)
 */

import { log } from '../../../../../lib/logger.js';
import * as tts from '../tts/messages.js';

/**
 * Maneja la fase ASK_SPECIALTY
 * @param {object} ctx - Contexto de la sesión (transcript, sessionId)
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function askSpecialty(ctx, state) {
  const { transcript } = ctx;

  // Si no hay transcript, es silencio o primer intento
  if (!transcript || transcript.trim().length === 0) {
    // Incrementar contador de intentos
    state.specialtyAttempts = (state.specialtyAttempts || 0) + 1;

    log("info", `[ASK_SPECIALTY] Intento #${state.specialtyAttempts} (silencio o primer intento)`);

    // Política de escalación progresiva
    if (state.specialtyAttempts === 1) {
      // Primer intento: pregunta completa con ejemplos
      const nombre = state.nombre_paciente ? state.nombre_paciente.split(' ')[0] : '';
      const saludo = nombre ? `Gracias, señor ${nombre}.` : 'Gracias.';

      return {
        ttsText: `${saludo} ¿Para qué especialidad médica necesita agendar su hora? Por ejemplo, medicina general, control o alguna especialidad en particular.`,
        nextPhase: 'ASK_SPECIALTY',
        shouldHangup: false,
        action: {
          type: "SET_STATE",
          payload: {
            updates: {
              rutPhase: 'ASK_SPECIALTY',
              specialtyAttempts: state.specialtyAttempts
            }
          }
        }
      };
    }

    if (state.specialtyAttempts === 2) {
      // Segundo intento: simplificado
      return {
        ttsText: tts.askSpecialtyRetry(),
        nextPhase: 'ASK_SPECIALTY',
        shouldHangup: false,
        action: {
          type: "SET_STATE",
          payload: {
            updates: {
              specialtyAttempts: state.specialtyAttempts
            }
          }
        }
      };
    }

    if (state.specialtyAttempts === 3) {
      // Tercer intento: ejemplos específicos
      return {
        ttsText: tts.askSpecialtyExamples(),
        nextPhase: 'ASK_SPECIALTY',
        shouldHangup: false,
        action: {
          type: "SET_STATE",
          payload: {
            updates: {
              specialtyAttempts: state.specialtyAttempts
            }
          }
        }
      };
    }

    // ✅ Cuarto intento o más: salida elegante con GOODBYE
    log("warn", `[ASK_SPECIALTY] Excedidos intentos (${state.specialtyAttempts}), transicionando a GOODBYE`);

    return {
      ttsText: null,  // GOODBYE manejará la despedida
      nextPhase: 'GOODBYE',
      shouldHangup: false,
      silent: true,
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

  // Si hay transcript, avanzar a PARSE_SPECIALTY
  log("info", `[ASK_SPECIALTY] Transcript recibido: "${transcript}", avanzando a PARSE_SPECIALTY`);

  // Transicionar inmediatamente a PARSE_SPECIALTY
  state.rutPhase = 'PARSE_SPECIALTY';

  return {
    ttsText: null,
    nextPhase: 'PARSE_SPECIALTY',
    silent: true,
    action: {
      type: "SET_STATE",
      payload: {
        updates: {
          rutPhase: 'PARSE_SPECIALTY'
        }
      }
    }
  };
}
