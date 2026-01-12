/**
 * 🎯 Handler para fase INFORM_AVAILABILITY
 * Informa la hora disponible al usuario
 */

import { log } from '../../../../../lib/logger.js';
import * as tts from '../tts/messages.js';

/**
 * Formatea la fecha para lectura en voz
 */
function formatDateForSpeech(dateStr) {
  if (!dateStr) return 'fecha no especificada';

  try {
    const date = new Date(dateStr);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (date.toDateString() === today.toDateString()) {
      return 'hoy';
    }
    if (date.toDateString() === tomorrow.toDateString()) {
      return 'mañana';
    }

    // Formato simple: "el día X"
    const day = date.getDate();
    const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const month = monthNames[date.getMonth()];

    return `el ${day} de ${month}`;
  } catch (err) {
    return dateStr;
  }
}

/**
 * Formatea la hora para lectura en voz
 */
function formatTimeForSpeech(timeStr) {
  if (!timeStr) return 'hora no especificada';

  // Convertir "14:30" a "dos y media" o "14:00" a "dos"
  const [hours, minutes] = timeStr.split(':').map(Number);
  const hourNames = ['cero', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once'];

  let hourText = hourNames[hours] || hours.toString();

  if (minutes === 0) {
    return hourText;
  } else if (minutes === 30) {
    return `${hourText} y media`;
  } else if (minutes === 15) {
    return `${hourText} y cuarto`;
  } else {
    return `${hourText} y ${minutes}`;
  }
}

/**
 * Maneja la fase INFORM_AVAILABILITY
 * @param {object} ctx - Contexto de la sesión (transcript, sessionId)
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function informAvailability(ctx, state) {
  const { fecha_hora, hora_seleccionada, doctor_box, especialidad } = state;

  if (!fecha_hora || !hora_seleccionada) {
    log("error", `❌ [INFORM_AVAILABILITY] Faltan datos: fecha_hora=${fecha_hora}, hora_seleccionada=${hora_seleccionada}`);
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

  // Formatear fecha (siempre HOY para este bot)
  const fechaTexto = "hoy"; // Simplificado: siempre es hoy
  const horaTexto = formatTimeForSpeech(hora_seleccionada);
  const doctorTexto = doctor_box ? ` con ${doctor_box}` : '';

  // Generar mensaje informativo (optimizado para adulto mayor)
  const ttsMessage = `Hay una hora disponible ${fechaTexto} a las ${horaTexto}${doctorTexto}. ¿Desea confirmarla?`;

  log("info", `[INFORM_AVAILABILITY] Informando: ${fechaTexto} ${horaTexto}${doctorTexto}`);

  state.rutPhase = 'CONFIRM_APPOINTMENT';

  // 🎯 REGLA: INFORM_AVAILABILITY NO es fase silenciosa
  // Necesita esperar confirmación del usuario (SÍ/NO)

  // Mensaje estructurado como pide el usuario
  const finalMessage = `Tengo disponible una hora ${fechaTexto} a las ${hora_seleccionada} ${doctorTexto}. ¿Le acomoda esta hora?`;

  return {
    ttsText: finalMessage,
    nextPhase: 'CONFIRM_APPOINTMENT',
    shouldHangup: false,
    skipUserInput: false, // ✅ NO es fase silenciosa: espera confirmación del usuario
    action: {
      type: "SET_STATE",
      payload: {
        updates: {
          rutPhase: 'CONFIRM_APPOINTMENT',
          appointmentAttempts: 0
        }
      }
    }
  };
}

