/**
 * 🎯 Handler para fase CHECK_AVAILABILITY
 * Consulta horas disponibles vía webhook
 */

import { log } from '../../../../../../lib/logger.js';
import { getNextAvailability } from '../webhook-client.js';
import * as tts from '../tts/messages.js';

/**
 * Maneja la fase CHECK_AVAILABILITY
 * @param {object} ctx - Contexto de la sesión (transcript, sessionId)
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function checkAvailability(ctx, state) {
  const { sessionId } = ctx;
  const { rutFormatted, especialidad, fecha_solicitada } = state;

  if (!rutFormatted || !especialidad) {
    log("error", `❌ [CHECK_AVAILABILITY] Faltan datos: rutFormatted=${rutFormatted}, especialidad=${especialidad}`);
    return {
      ttsText: "Ha ocurrido un error. Le transferiré con un ejecutivo.",
      nextPhase: 'FAILED',
      shouldHangup: true,
      action: {
        type: "END_CALL",
        payload: {
          reason: "FAILED",
          ttsText: "Ha ocurrido un error. Le transferiré con un ejecutivo."
        }
      }
    };
  }

  // 🛡️ Forzar fecha HOY si no está definida (seguridad)
  if (!fecha_solicitada || fecha_solicitada === 'ASAP') {
    const today = new Date();
    state.fecha_solicitada = today.toISOString().split('T')[0]; // YYYY-MM-DD
    state.dateSource = 'FORCED_TODAY';
    log("info", `[CHECK_AVAILABILITY] Fecha forzada a HOY: ${state.fecha_solicitada}`);
  }

  log("info", `[CHECK_AVAILABILITY] Buscando disponibilidad: RUT=${rutFormatted}, Especialidad=${especialidad}, Fecha=${state.fecha_solicitada}`);

  // 🎯 PASO 2: DELEGAR GET_NEXT_AVAILABILITY AL WEBHOOK
  const availabilityResult = await getNextAvailability(rutFormatted, especialidad, sessionId);
  log("info", `[CHECK_AVAILABILITY] Webhook respuesta: ok=${availabilityResult.ok}, horaFound=${availabilityResult.horaFound}, reason=${availabilityResult.reason || 'none'}`);

  if (!availabilityResult.ok) {
    // Error técnico - Aquí sí cortamos porque es fallo de sistema
    return {
      ttsText: "No fue posible consultar disponibilidad en este momento. Le transferiré con un ejecutivo.",
      nextPhase: 'FAILED',
      shouldHangup: true,
      skipUserInput: true, // ✅ FIX: No esperar voz, mensaje final
      action: {
        type: "END_CALL",
        payload: {
          reason: "FAILED",
          ttsText: "No fue posible consultar disponibilidad en este momento. Le transferiré con un ejecutivo."
        }
      }
    };
  }

  if (!availabilityResult.horaFound) {
    // No hay horas disponibles
    const reason = availabilityResult.reason;

    if (reason === 'SPECIALTY_NOT_MAPPED' || reason === 'NO_AVAILABILITY') {
      // NO_AVAILABILITY
      log("info", `[CHECK_AVAILABILITY] No availability found via Webhook. Reason: ${reason}`);
      // 🎯 TURNO 1: Notificación (Output Only)
      return {
        ttsText: tts.offerAnotherSpecialty(),
        nextPhase: 'OFFER_ALTERNATIVES',
        silent: false, // 🗣️ Engine habla
        action: {
          type: "SET_STATE",
          payload: {
            updates: {
              rutPhase: 'OFFER_ALTERNATIVES',
              alternativesAttempts: 0
            }
          }
        }
      };
    }

    // Errores técnicos (TIMEOUT, ERROR, INVALID_PARAMS)
    log("error", `[CHECK_AVAILABILITY] Error técnico en Webhook: ${reason}`);
    return {
      ttsText: "Ha ocurrido un error al consultar la disponibilidad. Por favor intente más tarde.",
      nextPhase: 'FAILED',
      shouldHangup: true,
      skipUserInput: true, // 🔇 Error técnico: finalizar inmediatamente
      action: {
        type: "END_CALL",
        payload: {
          reason: "WEBHOOK_ERROR",
          ttsText: "Ha ocurrido un error al consultar la disponibilidad. Por favor intente más tarde."
        }
      }
    };
  }

  /**
   * Formatea la hora para lectura en voz
   */
  function formatTimeForSpeech(timeStr) {
    if (!timeStr) return 'hora no especificada';
    const [hours, minutes] = timeStr.split(':').map(Number);
    const hourNames = ['cero', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once'];
    const hourText = hourNames[hours] || hours.toString();
    if (minutes === 0) return hourText;
    if (minutes === 30) return `${hourText} y media`;
    return `${hourText} y ${minutes}`;
  }

  // ✅ Hora encontrada → guardar y avanzar a INFORM_AVAILABILITY
  state.fecha_hora = availabilityResult.fecha;
  state.hora_seleccionada = availabilityResult.hora;
  state.doctor_box = availabilityResult.doctor_box;
  state.rutPhase = 'INFORM_AVAILABILITY';

  log("info", `✅ [CHECK_AVAILABILITY] Hora encontrada: ${availabilityResult.fecha} ${availabilityResult.hora} - ${availabilityResult.doctor_box}`);

  // 🎯 FIX V3: Informar disponibilidad INMEDIATAMENTE (Anti-silencio)
  // El guardrail del engine evitará duplicidad en la siguiente fase
  const fechaTexto = "hoy";
  const horaTexto = formatTimeForSpeech(state.hora_seleccionada);
  const doctorTexto = state.doctor_box ? ` con ${state.doctor_box}` : '';

  // Mensaje coincidente con inform-availability.js
  const ttsMessage = `Tengo disponible una hora ${fechaTexto} a las ${horaTexto}${doctorTexto}. ¿Le acomoda esta hora?`;

  return {
    ttsText: ttsMessage, // ✅ FIX: Enviar TTS explícito
    nextPhase: 'INFORM_AVAILABILITY',
    shouldHangup: false,
    skipUserInput: true, // 🔇 Mantenemos silent=true para que el Engine reproduzca y avance (loop) sin esperar record
    action: {
      type: "SET_STATE",
      payload: {
        updates: {
          fecha_hora: availabilityResult.fecha,
          hora_seleccionada: availabilityResult.hora,
          doctor_box: availabilityResult.doctor_box,
          rutPhase: 'INFORM_AVAILABILITY'
        }
      }
    }
  };
}

