/**
 * 🎯 Handler para fase WAIT_DV
 * Espera solo el dígito verificador
 */

import { log } from '../../../../../lib/logger.js';
import { extractRutCandidate } from '../rut/rut-parser.js';
import { validateRut, normalizeRutFull } from '../rut/rut-validator.js';
import { getMaskedReading } from '../rut/rut-normalizer.js';
import { cleanAsrNoise } from '../utils.js';
import * as tts from '../tts/messages.js';

/**
 * Maneja la fase WAIT_DV
 * @param {object} ctx - Contexto de la sesión
 * @param {object} state - Estado del dominio
 * @returns {object} - { ttsText: string|null, nextPhase: string|null, shouldHangup: boolean }
 */
export default function waitDV(ctx, state) {
  const { transcript } = ctx;
  const result = {
    ttsText: null,
    nextPhase: null,
    shouldHangup: false
  };

  const cleanTranscript = (transcript || "").toLowerCase();

  log("debug", `⚙️ [WAIT_DV] Input="${cleanTranscript}" Body=${state.rutBody}`);

  // Limpiar ruido social primero
  const cleanedDV = cleanAsrNoise(transcript);
  
  // Si después de limpiar solo queda ruido, ignorar
  if (!cleanedDV || cleanedDV.trim().length === 0 || /^(Y|Y\s+BUENAS|BUENAS|NOCHE|HOLA)$/i.test(cleanedDV.trim())) {
    state.rutAttempts++;
    log("info", `🔇 [WAIT_DV] Ruido social ignorado: "${transcript}". Intento #${state.rutAttempts}`);
    
    if (state.rutAttempts >= 3) {
      state.rutPhase = 'FAILED';
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
    } else {
      return {
        ttsText: "Solo necesito el dígito verificador, por ejemplo: ocho o K.",
        nextPhase: 'WAIT_DV',
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
  }

  // Intentar extraer DV con regex primero
  const dvMatch = cleanedDV.match(/([0-9K])/);
  if (dvMatch) {
    const dv = dvMatch[1].toUpperCase();
    const isValid = validateRut(state.rutBody, dv);

    if (isValid) {
      state.rutDv = dv;
      state.rutPhase = 'CONFIRM';
      state.rutAttempts = 0;
      state.confirmAttempts = 0;

      const maskedReading = getMaskedReading(state.rutBody, dv);
      const rutFormatted = normalizeRutFull(state.rutBody, dv);
      
      log("info", `✅ [WAIT_DV] DV válido capturado: ${dv}. RUT=${rutFormatted}`);
      
      return {
        ttsText: tts.confirmRut(maskedReading),
        nextPhase: 'CONFIRM',
        shouldHangup: false,
        action: {
          type: "SET_STATE",
          payload: {
            updates: {
              rutDv: dv,
              rutFormatted: rutFormatted,
              rutPhase: 'CONFIRM',
              rutAttempts: 0,
              confirmAttempts: 0
            }
          }
        }
      };
    } else {
      // DV no calza matemáticamente, pero pedimos confirmación
      state.rutDv = dv;
      state.rutPhase = 'CONFIRM';
      state.rutAttempts = 0;
      state.confirmAttempts = 0;

      const maskedReading = getMaskedReading(state.rutBody, dv);
      const rutFormatted = `${state.rutBody}-${dv}`;
      
      log("warn", `⚠️ [WAIT_DV] DV no calza matemáticamente pero pedimos confirmación. Body=${state.rutBody} DV=${dv}`);
      
      return {
        ttsText: tts.confirmRut(maskedReading),
        nextPhase: 'CONFIRM',
        shouldHangup: false,
        action: {
          type: "SET_STATE",
          payload: {
            updates: {
              rutDv: dv,
              rutFormatted: rutFormatted,
              rutPhase: 'CONFIRM',
              rutAttempts: 0,
              confirmAttempts: 0
            }
          }
        }
      };
    }
  }

  // Si regex falló, intentar parser semántico
  const candidate = extractRutCandidate(transcript);
  
  if (candidate.dv) {
    const isValid = validateRut(state.rutBody, candidate.dv);

    if (isValid) {
      state.rutDv = candidate.dv;
      state.rutPhase = 'CONFIRM';
      state.rutAttempts = 0;
      state.confirmAttempts = 0;

      const maskedReading = getMaskedReading(state.rutBody, candidate.dv);
      const rutFormatted = normalizeRutFull(state.rutBody, candidate.dv);
      
      log("info", `✅ [WAIT_DV] DV válido capturado (semántico): ${candidate.dv}`);
      
      return {
        ttsText: tts.confirmRut(maskedReading),
        nextPhase: 'CONFIRM',
        shouldHangup: false,
        action: {
          type: "SET_STATE",
          payload: {
            updates: {
              rutDv: candidate.dv,
              rutFormatted: rutFormatted,
              rutPhase: 'CONFIRM',
              rutAttempts: 0,
              confirmAttempts: 0
            }
          }
        }
      };
    } else {
      // DV no calza, pero pedimos confirmación
      state.rutDv = candidate.dv;
      state.rutPhase = 'CONFIRM';
      state.rutAttempts = 0;
      state.confirmAttempts = 0;

      const maskedReading = getMaskedReading(state.rutBody, candidate.dv);
      const rutFormatted = `${state.rutBody}-${candidate.dv}`;
      
      log("warn", `⚠️ [WAIT_DV] DV no calza (semántico) pero pedimos confirmación. DV=${candidate.dv}`);
      
      return {
        ttsText: tts.confirmRut(maskedReading),
        nextPhase: 'CONFIRM',
        shouldHangup: false,
        action: {
          type: "SET_STATE",
          payload: {
            updates: {
              rutDv: candidate.dv,
              rutFormatted: rutFormatted,
              rutPhase: 'CONFIRM',
              rutAttempts: 0,
              confirmAttempts: 0
            }
          }
        }
      };
    }
  }

  // No se capturó DV
  state.rutAttempts++;
  log("warn", `⚠️ [WAIT_DV] No se capturó DV. Intento #${state.rutAttempts}`);
  
  if (state.rutAttempts >= 3) {
    state.rutPhase = 'FAILED';
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
  } else {
    return {
      ttsText: tts.askDv(),
      nextPhase: 'WAIT_DV',
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
}

