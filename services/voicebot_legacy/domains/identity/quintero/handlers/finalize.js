/**
 * 🎯 Handler para fase FINALIZE
 * Confirma la hora vía webhook y finaliza la llamada
 */

import { log } from '../../../../../../lib/logger.js';
import { confirmAvailability } from '../webhook-client.js';
import * as tts from '../tts/messages.js';

/**
 * Maneja la fase FINALIZE
 * @param {object} ctx - Contexto de la sesión (transcript, sessionId)
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function finalize(ctx, state) {
  const { sessionId } = ctx;
  const { especialidad, fecha_hora, hora_seleccionada } = state;

  log("info", `[FINALIZE] Confirmando hora: Especialidad=${especialidad}, Fecha=${fecha_hora}, Hora=${hora_seleccionada}`);

  // 🎯 EVENTO 4: DELEGAR CONFIRM_AVAILABILITY AL WEBHOOK
  const confirmResult = await confirmAvailability(sessionId);
  log("info", `[FINALIZE] Webhook CONFIRM_AVAILABILITY respuesta: ok=${confirmResult.ok}, confirmed=${confirmResult.confirmed}, reason=${confirmResult.reason || 'none'}`);

  if (!confirmResult.ok || !confirmResult.confirmed) {
    // Error o hold expirado
    const reason = confirmResult.reason;

    if (reason === 'HOLD_NOT_FOUND_OR_EXPIRED') {
      return {
        ttsText: tts.holdExpired(),
        nextPhase: 'ASK_DATE',
        shouldHangup: false,
        action: {
          type: "SET_STATE",
          payload: {
            updates: {
              rutPhase: 'ASK_DATE',
              fecha_hora: null,
              hora_seleccionada: null,
              doctor_box: null
            }
          }
        }
      };
    }

    // Otro error
    return {
      ttsText: "No fue posible confirmar su hora. Le transferiré con un ejecutivo.",
      nextPhase: 'FAILED',
      shouldHangup: true,
      action: {
        type: "END_CALL",
        payload: {
          reason: "FAILED",
          ttsText: "No fue posible confirmar su hora. Le transferiré con un ejecutivo."
        }
      }
    };
  }

  // ✅ Hora confirmada exitosamente
  const fechaTexto = fecha_hora ? new Date(fecha_hora).toLocaleDateString('es-CL') : 'fecha';
  const horaTexto = hora_seleccionada || 'hora';

  log("info", `✅ [FINALIZE] Hora confirmada exitosamente: ${especialidad} - ${fechaTexto} ${horaTexto}`);

  state.rutPhase = 'COMPLETE';

  return {
    ttsText: `Su hora ha sido confirmada para ${especialidad || 'la especialidad'} el ${fechaTexto} a las ${horaTexto}. Muchas gracias, hasta luego.`,
    nextPhase: 'COMPLETE',
    shouldHangup: true,
    skipUserInput: true, // 🔇 Fase silenciosa: NO esperar voz, finalizar inmediatamente
    action: {
      type: "END_CALL",
      payload: {
        reason: "COMPLETE",
        ttsText: `Su hora ha sido confirmada para ${especialidad || 'la especialidad'} el ${fechaTexto} a las ${horaTexto}. Muchas gracias, hasta luego.`
      }
    }
  };
}

