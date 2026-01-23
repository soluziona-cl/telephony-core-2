/**
 * 🧠 State Machine del bot Quintero
 * Maneja los estados conversacionales: WAIT_BODY → WAIT_DV → CONFIRM → COMPLETE
 */

import { log } from '../../../../lib/logger.js';
import WAIT_RUT from '../phases/WAIT_RUT.js';
// import waitBody from './handlers/wait-body.js'; // 🗑️ Legacy
// import waitDV from './handlers/wait-dv.js'; // 🗑️ Legacy
import confirm from './handlers/confirm.js';
import askSpecialty from './handlers/ask-specialty.js';
import parseSpecialty from './handlers/parse-specialty.js';
import offerAlternatives from './handlers/offer-alternatives.js';
import offerAlternativesIntro from './handlers/offer-alternatives-intro.js';
import offerAlternativesWait from './handlers/offer-alternatives-wait.js';
import checkAvailability from './handlers/check-availability.js';
import informAvailability from './handlers/inform-availability.js';
import confirmAppointment from './handlers/confirm-appointment.js';
import finalize from './handlers/finalize.js';
import startGreeting from './handlers/start-greeting.js';
import goodbye from './handlers/goodbye.js';
import * as tts from './tts/messages.js';

/**
 * Crea el estado inicial del dominio
 * @returns {object} - Estado inicial
 */
export function initialState() {
  return {
    rutPhase: 'START_GREETING',
    rutBody: null,
    rutDv: null,
    rutFormatted: null, // RUT completo formateado desde webhook FORMAT_RUT
    dni: null,
    patient: null,
    nombre_paciente: null, // Nombre desde webhook VALIDATE_PATIENT
    edad_paciente: null, // Edad desde webhook VALIDATE_PATIENT
    especialidad: null, // Especialidad detectada
    fecha_hora: null, // Fecha y hora desde webhook GET_NEXT_AVAILABILITY
    doctor_box: null, // Doctor desde webhook GET_NEXT_AVAILABILITY
    fecha_solicitada: null, // Fecha solicitada por el usuario
    horas_disponibles: null, // Array de horas disponibles
    hora_seleccionada: null, // Hora seleccionada por el usuario
    rutAttempts: 0,
    confirmAttempts: 0,
    specialtyAttempts: 0,
    dateAttempts: 0,
    appointmentAttempts: 0,
    alternativesAttempts: 0,
    confirmed: false,
    lastTtsPhase: null, // 🛡️ Anti-replay: Última fase hablada
    lastTtsText: null,   // 🛡️ Anti-replay: Último texto hablado
    greetingPlayed: false, // 🛡️ State: Flag para controlar saludo inicial único
    identificador: 'PENDING' // ✅ BusinessState: Identificador de sesión para SQL
  };
}

/**
 * Ejecuta el handler correspondiente según la fase actual
 * @param {object} ctx - Contexto de la sesión (transcript, ari, channel, etc.)
 * @param {object} state - Estado actual del dominio
 * @returns {Promise<object>} - Resultado del handler
 */
export async function runState(ctx, state) {
  const { rutPhase } = state;

  log("debug", `🔄 [STATE MACHINE] Fase actual: ${rutPhase}`);

  let result;

  switch (rutPhase) {
    case 'START_GREETING':
      result = await startGreeting(ctx, state);
      break;

    // 🆔 FASE UNIFICADA DE RUT (Reemplaza WAIT_BODY / WAIT_DV)
    case 'WAIT_RUT':
    case 'WAIT_BODY': // Backwards compatibility redirect
    case 'WAIT_DV':   // Backwards compatibility redirect
      result = await WAIT_RUT(ctx, state);

      // 🪝 Manejo de respuesta del Webhook FORMAT_RUT
      if (ctx.event === 'WEBHOOK_RESPONSE' && ctx.webhookData?.action === 'FORMAT_RUT') {
        const { data } = ctx.webhookData;

        if (!data || !data.ok) {
          // RUT inválido o error en webhook -> Repetir
          result = {
            nextPhase: 'WAIT_RUT',
            ttsText: 'No pude reconocer el RUT. Por favor repítalo completo.',
            silent: false,
            skipUserInput: false,
            action: { type: 'SET_STATE' }
          };
        } else {
          // RUT válido -> Guardar y avanzar
          const { rut } = data;
          state.rutFormatted = rut; // Guardar en state

          log('info', '✅ [STATE MACHINE] RUT reconocido y formateado', { rut });

          result = {
            nextPhase: 'VALIDATE_PATIENT', // Siguiente fase lógica
            ttsText: null,
            silent: false,
            skipUserInput: true,
            action: {
              type: 'WEBHOOK',
              action: 'VALIDATE_PATIENT',
              rut
            }
          };
        }
      }
      break;

    case 'CONFIRM':
      result = await confirm(ctx, state);
      break;

    case 'ASK_SPECIALTY':
      result = await askSpecialty(ctx, state);
      // Si askSpecialty devuelve nextPhase='PARSE_SPECIALTY', el handler ya cambió el estado
      if (result.nextPhase === 'PARSE_SPECIALTY') {
        // El handler ya actualizó state.rutPhase, ejecutar parseSpecialty directamente
        result = await parseSpecialty(ctx, state);
      }
      break;

    case 'PARSE_SPECIALTY':
      result = await parseSpecialty(ctx, state);
      break;

    case 'ASK_DATE':
      result = await askDate(ctx, state);
      break;

    case 'CHECK_AVAILABILITY':
      result = await checkAvailability(ctx, state);
      break;

    case 'OFFER_ALTERNATIVES':
      result = await offerAlternatives(ctx, state);
      break;

    case 'INFORM_AVAILABILITY':
      result = await informAvailability(ctx, state);
      break;

    case 'CONFIRM_APPOINTMENT':
      result = await confirmAppointment(ctx, state);
      break;

    case 'OFFER_ALTERNATIVES_INTRO':
      result = await offerAlternativesIntro(ctx, state);
      break;

    case 'OFFER_ALTERNATIVES_WAIT':
      result = await offerAlternativesWait(ctx, state);
      break;

    case 'GOODBYE':
      result = await goodbye(ctx, state);
      break;

    case 'FINALIZE':
      result = await finalize(ctx, state);
      break;

    case 'COMPLETE':
      // Estado final - colgar inmediatamente
      log("info", "✅ [STATE MACHINE] Finalizando llamada");
      result = {
        ttsText: null,
        nextPhase: 'COMPLETE',
        shouldHangup: true,
        action: {
          type: "END_CALL",
          payload: {
            reason: "COMPLETED"
          }
        }
      };
      break;

    case 'FAILED':
    case 'ERROR':
      // Estado de error - transferir a humano
      log("warn", `⚠️ [STATE MACHINE] Estado de error: ${rutPhase}`);
      result = {
        ttsText: tts.confirmFailEscalate(),
        nextPhase: 'FAILED',
        shouldHangup: true
      };
      break;

    default:
      log("error", `❌ [STATE MACHINE] Fase desconocida: ${rutPhase}`);
      result = {
        ttsText: "Ha ocurrido un error interno. Le transferiré con una ejecutiva.",
        nextPhase: 'ERROR',
        shouldHangup: true
      };
  }

  // Actualizar fase si el handler indica un cambio
  if (result.nextPhase && result.nextPhase !== rutPhase) {
    state.rutPhase = result.nextPhase;
    log("info", `🔄 [STATE MACHINE] Transición: ${rutPhase} → ${result.nextPhase}`);
  }

  // 🛡️ FIX ORQUESTACIÓN: Evitar repetición de TTS idéntico en re-evaluación
  if (result.ttsText) {
    if (state.lastTtsPhase === result.nextPhase && state.lastTtsText === result.ttsText) {
      log("warn", `🔇 [STATE MACHINE] TTS Duplicado detectado para fase ${result.nextPhase}. Silenciando.`);
      result.ttsText = null;
    } else {
      // Registrar nuevo TTS
      state.lastTtsPhase = result.nextPhase;
      state.lastTtsText = result.ttsText;
    }
  }

  return result;
}

export default {
  initialState,
  runState
};

