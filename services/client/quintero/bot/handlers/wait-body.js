/**
 * 🎯 Handler para fase WAIT_BODY
 * Espera captura del RUT completo (body + DV)
 * DELEGA al webhook FORMAT_RUT
 */

import { log } from '../../../../../lib/logger.js';
import { formatRut as webhookFormatRut } from '../../n8n/webhook-client.js';
import { getMaskedReading } from '../rut/rut-normalizer.js';
import * as tts from '../tts/messages.js';

/**
 * Maneja la fase WAIT_BODY
 * @param {object} ctx - Contexto de la sesión (transcript, sessionId, ani, dnis)
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - { ttsText: string|null, nextPhase: string|null, shouldHangup: boolean }
 */
export default async function waitBody(ctx, state) {
  const { transcript, sessionId, ani, dnis } = ctx;

  const cleanTranscript = transcript || "";
  log("debug", `⚙️ [WAIT_BODY] Input="${cleanTranscript}"`);

  // 🛡️ GUARDRAIL & SILENCE HANDLING
  // Si no hay input, debemos decidir si es el saludo inicial o un silencio posterior
  if (!cleanTranscript || cleanTranscript.trim().length === 0) {

    // CASO 1: SILENCIO (Usuario no habla)
    // El saludo inicial YA se jugó en START_GREETING. Si llegamos aquí con empty, es silencio.

    log("info", `🛡️ [WAIT_BODY] Silence detected. Treating as NO_INPUT.`);

    // Incrementar intentos de RUT (usamos la misma métrica de intentos)
    state.rutAttempts++;

    if (state.rutAttempts >= 3) {
      state.rutPhase = 'FAILED';
      return {
        ttsText: tts.rutCaptureFailed(),
        nextPhase: 'FAILED',
        shouldHangup: true,
        action: {
          type: "END_CALL",
          payload: {
            reason: "FAILED_SILENCE",
            ttsText: tts.rutCaptureFailed()
          }
        }
      };
    }

    return {
      ttsText: tts.askRutRetry(),
      nextPhase: 'WAIT_BODY',
      shouldHangup: false,
      action: {
        type: "SET_STATE",
        payload: {
          updates: {
            rutAttempts: state.rutAttempts
          }
        }
      }
    };
  }

  // 🎯 EVENTO 1: DELEGAR FORMAT_RUT AL WEBHOOK
  log("info", `[DOMAIN] Webhook FORMAT_RUT invocado para transcript: "${cleanTranscript}"`);
  const formatResult = await webhookFormatRut(cleanTranscript, sessionId, ani, dnis);
  log("info", `[DOMAIN] Webhook FORMAT_RUT respuesta: ok=${formatResult.ok}, rut=${formatResult.rut || 'null'}, reason=${formatResult.reason || 'none'}`);

  if (formatResult.ok && formatResult.rut) {
    // ✅ Webhook formateó el RUT → guardar y pasar a CONFIRM con acción estructurada
    const rutFormatted = formatResult.rut; // Ej: "14348258-8"
    const parts = rutFormatted.split('-');
    state.rutBody = parts[0];
    state.rutDv = parts[1] || '';
    state.rutFormatted = rutFormatted;
    state.rutPhase = 'CONFIRM';
    state.rutAttempts = 0;
    state.confirmAttempts = 0;

    const maskedReading = getMaskedReading(state.rutBody, state.rutDv);

    // 🎯 CONTRATO: Devolver acción estructurada
    return {
      ttsText: tts.confirmRut(maskedReading),
      nextPhase: 'CONFIRM',
      shouldHangup: false,
      action: {
        type: "SET_STATE",
        payload: {
          updates: {
            rutBody: state.rutBody,
            rutDv: state.rutDv,
            rutFormatted: rutFormatted
          }
        }
      }
    };
  }

  // Si el webhook no pudo formatear → incrementar intentos
  state.rutAttempts++;
  log("warn", `⚠️ [WEBHOOK] FORMAT_RUT falló. Intento #${state.rutAttempts}, reason=${formatResult.reason || 'unknown'}`);

  if (state.rutAttempts >= 3) {
    state.rutPhase = 'FAILED';

    // 🎯 CONTRATO: Acción de cierre
    return {
      ttsText: tts.rutCaptureFailed(),
      nextPhase: 'FAILED',
      shouldHangup: true,
      action: {
        type: "END_CALL",
        payload: {
          reason: "FAILED",
          ttsText: tts.rutCaptureFailed()
        }
      }
    };
  }

  // Mensaje según el tipo de error
  const ttsMessage = formatResult.reason === 'INVALID_RUT_FORMAT'
    ? tts.askRutRetry()
    : (state.rutAttempts === 1 ? tts.askRut() : tts.askRutRetry());

  // 🎯 CONTRATO: SIEMPRE devolver acción explícita (nunca null)
  // Incrementar contador de intentos en el estado
  return {
    ttsText: ttsMessage,
    nextPhase: 'WAIT_BODY',
    shouldHangup: false,
    action: {
      type: "SET_STATE",
      payload: {
        updates: {
          rutAttempts: state.rutAttempts
        }
      }
    }
  };
}

