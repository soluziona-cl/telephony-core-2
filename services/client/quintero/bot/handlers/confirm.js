/**
 * 🎯 Handler para fase CONFIRM
 * Confirma el RUT detectado con el usuario
 * DELEGA al webhook VALIDATE_PATIENT
 */

import { log } from '../../../../../lib/logger.js';
import { classifyConfirm } from '../../openai/confirm-classifier.js';
import { validatePatient as webhookValidatePatient } from '../../n8n/webhook-client.js';
import { getMaskedReading } from '../rut/rut-normalizer.js';
import * as tts from '../tts/messages.js';

/**
 * Maneja la fase CONFIRM
 * @param {object} ctx - Contexto de la sesión (transcript, sessionId)
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - { ttsText: string|null, nextPhase: string|null, shouldHangup: boolean }
 */
export default async function confirm(ctx, state) {
  const { transcript, sessionId } = ctx;
  const result = {
    ttsText: null,
    nextPhase: null,
    shouldHangup: false
  };

  const cleanTranscript = (transcript || "").toLowerCase();

  // Inicializar contador si no existe
  if (state.confirmAttempts === undefined) {
    state.confirmAttempts = 0;
  }
  state.confirmAttempts++;

  log("debug", `⚙️ [CONFIRM] Intento #${state.confirmAttempts} Input="${cleanTranscript}"`);

  // Clasificar intención de confirmación
  const confirmIntent = classifyConfirm(cleanTranscript);
  log("info", `🔍 [CONFIRM] Intent="${confirmIntent}", Transcript="${cleanTranscript}"`);

  if (confirmIntent === 'YES') {
    // ✅ RUT confirmado → EVENTO 2: VALIDATE_PATIENT
    const rutFormatted = state.rutFormatted || `${state.rutBody}-${state.rutDv}`;

    log("info", `✅ [STATE] CONFIRM(YES) → Validando paciente con webhook: ${rutFormatted}`);

    // 🎯 EVENTO 2: DELEGAR VALIDATE_PATIENT AL WEBHOOK
    log("info", `[DOMAIN] Webhook VALIDATE_PATIENT invocado para RUT: ${rutFormatted}`);
    const validateResult = await webhookValidatePatient(rutFormatted, sessionId);
    log("info", `[DOMAIN] Webhook VALIDATE_PATIENT respuesta: ok=${validateResult.ok}, patientFound=${validateResult.patientFound}, nombre=${validateResult.nombre || 'null'}`);

    if (!validateResult.ok) {
      // Error en webhook → mensaje estándar y cierre
      return {
        ttsText: "No fue posible validar sus datos. Por favor, comuníquese con el consultorio.",
        nextPhase: 'FAILED',
        shouldHangup: true,
        action: {
          type: "END_CALL",
          payload: {
            reason: "FAILED",
            ttsText: "No fue posible validar sus datos. Por favor, comuníquese con el consultorio."
          }
        }
      };
    }

    if (!validateResult.patientFound) {
      // Paciente NO existe → mensaje estándar y cierre
      return {
        ttsText: "No fue posible validar sus datos. Por favor, comuníquese con el consultorio.",
        nextPhase: 'FAILED',
        shouldHangup: true,
        action: {
          type: "END_CALL",
          payload: {
            reason: "FAILED",
            ttsText: "No fue posible validar sus datos. Por favor, comuníquese con el consultorio."
          }
        }
      };
    }

    // ✅ Paciente encontrado → avanzar a ASK_SPECIALTY
    state.dni = rutFormatted;
    state.rutPhase = 'ASK_SPECIALTY';
    state.confirmAttempts = 0;
    state.nombre_paciente = validateResult.nombre;
    state.edad_paciente = validateResult.edad;

    // 🎯 CONTRATO: Avanzar a fase de especialidad
    return {
      ttsText: validateResult.nombre
        ? `Gracias, señor ${validateResult.nombre.split(' ')[0]}. ¿Para qué especialidad médica necesita agendar su hora? Por ejemplo, medicina general, control o alguna especialidad en particular.`
        : tts.patientNotFound(),
      nextPhase: 'ASK_SPECIALTY',
      shouldHangup: false,
      action: {
        type: "SET_STATE",
        payload: {
          updates: {
            nombre_paciente: validateResult.nombre,
            edad_paciente: validateResult.edad,
            rutPhase: 'ASK_SPECIALTY'
          }
        }
      }
    };
  }

  if (confirmIntent === 'NO') {
    // ❌ RECHAZO → RESET a WAIT_BODY
    log("info", `🔄 [CONFIRM] NO → WAIT_BODY`);
    state.rutPhase = 'WAIT_BODY';
    state.rutBody = null;
    state.rutDv = null;
    state.rutFormatted = null;
    state.rutAttempts = 0;
    state.confirmAttempts = 0;

    // 🎯 CONTRATO: Acción explícita para resetear estado
    return {
      ttsText: tts.confirmRetry(),
      nextPhase: 'WAIT_BODY',
      shouldHangup: false,
      action: {
        type: "SET_STATE",
        payload: {
          updates: {
            rutPhase: 'WAIT_BODY',
            rutBody: null,
            rutDv: null,
            rutFormatted: null,
            rutAttempts: 0,
            confirmAttempts: 0
          }
        }
      }
    };
  }

  // UNKNOWN → Aceptación implícita después de 2 intentos
  if (state.confirmAttempts >= 2) {
    // 🔥 ACEPTACIÓN IMPLÍCITA: Si no dice NO después de 2 intentos, asumimos SÍ
    log("info", `✅ [STATE] Aceptación implícita después de ${state.confirmAttempts} intentos. Transcript: "${cleanTranscript}"`);

    const rutFormatted = state.rutFormatted || `${state.rutBody}-${state.rutDv}`;

    // 🎯 EVENTO 2: VALIDATE_PATIENT (aceptación implícita)
    log("info", `[DOMAIN] Webhook VALIDATE_PATIENT invocado (implícito) para RUT: ${rutFormatted}`);
    const validateResult = await webhookValidatePatient(rutFormatted, sessionId);
    log("info", `[DOMAIN] Webhook VALIDATE_PATIENT respuesta (implícito): ok=${validateResult.ok}, patientFound=${validateResult.patientFound}`);

    if (!validateResult.ok || !validateResult.patientFound) {
      // 🎯 CONTRATO: Acción de cierre por fallo
      return {
        ttsText: "No fue posible validar sus datos. Por favor, comuníquese con el consultorio.",
        nextPhase: 'FAILED',
        shouldHangup: true,
        action: {
          type: "END_CALL",
          payload: {
            reason: "FAILED",
            ttsText: "No fue posible validar sus datos. Por favor, comuníquese con el consultorio."
          }
        }
      };
    }

    state.dni = rutFormatted;
    state.rutPhase = 'COMPLETE';
    state.confirmAttempts = 0;
    state.nombre_paciente = validateResult.nombre;
    state.edad_paciente = validateResult.edad;

    // 🎯 CONTRATO: Cambiar a engine con query para gestión de horas
    return {
      ttsText: validateResult.nombre
        ? tts.patientFound(validateResult.nombre)
        : tts.patientNotFound(),
      nextPhase: 'COMPLETE',
      shouldHangup: false,
      action: {
        type: "USE_ENGINE",
        payload: {
          engine: "WITH_QUERY",
          context: {
            rut: rutFormatted,
            nombre: validateResult.nombre,
            edad: validateResult.edad,
            bot: "quintero"
          }
        }
      }
    };
  }

  // Primer intento UNKNOWN: repetir confirmación
  const maskedReading = getMaskedReading(state.rutBody, state.rutDv);

  // 🎯 CONTRATO: Siempre devolver acción explícita
  return {
    ttsText: state.confirmAttempts === 1
      ? tts.confirmRut(maskedReading)
      : tts.confirmRepeat(maskedReading), // Usar versión larga con variación "No le entendí bien"
    nextPhase: 'CONFIRM',
    shouldHangup: false,
    action: {
      type: "SET_STATE",
      payload: {
        updates: {
          confirmAttempts: state.confirmAttempts
        }
      }
    }
  };
}

