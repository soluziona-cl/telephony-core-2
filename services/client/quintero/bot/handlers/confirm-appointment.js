/**
 * 🎯 Handler para fase CONFIRM_APPOINTMENT
 * Confirma la hora seleccionada con el usuario
 */

import { log } from '../../../../../lib/logger.js';
import { classifyConfirm } from '../../openai/confirm-classifier.js';
import * as tts from '../tts/messages.js';

/**
 * Maneja la fase CONFIRM_APPOINTMENT
 * @param {object} ctx - Contexto de la sesión (transcript, sessionId)
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function confirmAppointment(ctx, state) {
  const { transcript } = ctx;
  const cleanTranscript = (transcript || '').toLowerCase();
  
  log("info", `[CONFIRM_APPOINTMENT] Transcript: "${cleanTranscript}"`);
  
  // Inicializar contador si no existe
  if (state.appointmentAttempts === undefined) {
    state.appointmentAttempts = 0;
  }
  state.appointmentAttempts++;
  
  // Clasificar intención de confirmación
  const confirmIntent = classifyConfirm(cleanTranscript);
  log("info", `[CONFIRM_APPOINTMENT] Intent="${confirmIntent}", Intento #${state.appointmentAttempts}`);
  
  if (confirmIntent === 'YES') {
    // ✅ Confirmación → avanzar a FINALIZE
    state.rutPhase = 'FINALIZE';
    state.confirmed = true;
    
    log("info", `✅ [CONFIRM_APPOINTMENT] Hora confirmada por usuario`);
    
    return {
      ttsText: "Perfecto, confirmando su hora.",
      nextPhase: 'FINALIZE',
      shouldHangup: false,
      action: {
        type: "SET_STATE",
        payload: {
          updates: {
            rutPhase: 'FINALIZE',
            confirmed: true
          }
        }
      }
    };
  }
  
  if (confirmIntent === 'NO') {
    // ❌ Rechazo → volver a buscar disponibilidad
    log("info", `🔄 [CONFIRM_APPOINTMENT] Usuario rechazó la hora, volviendo a buscar`);
    
    // Liberar hold si existe
    const { releaseAvailability } = await import('../../n8n/webhook-client.js');
    await releaseAvailability(ctx.sessionId);
    
    state.rutPhase = 'ASK_DATE';
    state.fecha_hora = null;
    state.hora_seleccionada = null;
    state.doctor_box = null;
    
    return {
      ttsText: "De acuerdo, busquemos otra opción. ¿Desea agendar para hoy o para otra fecha?",
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
  
  // UNKNOWN → Aceptación implícita después de 2 intentos
  if (state.appointmentAttempts >= 2) {
    log("info", `✅ [CONFIRM_APPOINTMENT] Aceptación implícita después de ${state.appointmentAttempts} intentos`);
    
    state.rutPhase = 'FINALIZE';
    state.confirmed = true;
    
    return {
      ttsText: "Perfecto, confirmando su hora.",
      nextPhase: 'FINALIZE',
      shouldHangup: false,
      action: {
        type: "SET_STATE",
        payload: {
          updates: {
            rutPhase: 'FINALIZE',
            confirmed: true
          }
        }
      }
    };
  }
  
  // Repetir confirmación
  const { fecha_hora, hora_seleccionada, doctor_box, especialidad } = state;
  const fechaTexto = fecha_hora ? new Date(fecha_hora).toLocaleDateString('es-CL') : 'fecha';
  const horaTexto = hora_seleccionada || 'hora';
  
  return {
    ttsText: `¿Confirma su hora para ${especialidad || 'la especialidad'} el ${fechaTexto} a las ${horaTexto}? Dígame sí o no.`,
    nextPhase: 'CONFIRM_APPOINTMENT',
    shouldHangup: false,
    action: {
      type: "SET_STATE",
      payload: {
        updates: {
          appointmentAttempts: state.appointmentAttempts
        }
      }
    }
  };
}

