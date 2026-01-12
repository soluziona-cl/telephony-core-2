/**
 * 🎯 Handler para fase PARSE_SPECIALTY
 * Interpreta la especialidad mencionada por el usuario
 * Consulta la tabla Especialidad_Map en SQL Server
 */

import { log } from '../../../../../../lib/logger.js';
import { getSpecialtyFromMap } from '../../../../shared/db-queries.js';
import { getNextAvailability, prefetchNextAvailability } from '../webhook-client.js';
import * as tts from '../tts/messages.js';

/**
 * Mapeo de especialidades locales (fallback si la tabla SQL no está disponible)
 * Solo se usa si getSpecialtyFromMap falla
 */
const FALLBACK_SPECIALTY_MAP = {
  'medicina general': 'Medicina General',
  'medicina': 'Medicina General',
  'general': 'Medicina General',
  'control': 'Medicina General',
  'consulta': 'Medicina General',
  'dental': 'Odontología',
  'odontología': 'Odontología',
  'diente': 'Odontología',
  'muela': 'Odontología',
  'pediatría': 'Pediatría',
  'niño': 'Pediatría',
  'niña': 'Pediatría',
  'ginecología': 'Ginecología',
  'ginecólogo': 'Ginecología',
  'matrona': 'Ginecología',
  'cardiología': 'Cardiología',
  'corazón': 'Cardiología',
  'traumatología': 'Traumatología',
  'hueso': 'Traumatología',
  'fractura': 'Traumatología'
};

/**
 * Normaliza y clasifica la especialidad
 * Primero consulta la tabla Especialidad_Map, luego usa fallback local
 */
async function classifySpecialty(transcript) {
  const text = (transcript || '').toLowerCase().trim();

  // 🎯 PASO 1: Consultar tabla Especialidad_Map en SQL Server
  try {
    const dbResult = await getSpecialtyFromMap(transcript);

    if (dbResult.found && dbResult.specialty) {
      log("info", `✅ [PARSE_SPECIALTY] Especialidad encontrada en BD: ${dbResult.specialty} (confidence: ${dbResult.confidence})`);
      return dbResult;
    }
  } catch (err) {
    log("warn", `⚠️ [PARSE_SPECIALTY] Error consultando Especialidad_Map: ${err.message}, usando fallback local`);
  }

  // 🎯 PASO 2: Fallback a mapeo local si BD no tiene resultados
  for (const [key, value] of Object.entries(FALLBACK_SPECIALTY_MAP)) {
    if (text.includes(key)) {
      log("info", `✅ [PARSE_SPECIALTY] Especialidad encontrada en fallback local: ${value}`);
      return { found: true, specialty: value, confidence: 'medium' };
    }
  }

  // Si contiene palabras clave pero no está mapeada
  if (text.includes('especialidad') || text.includes('especialista')) {
    return { found: false, specialty: null, confidence: 'low' };
  }

  return { found: false, specialty: null, confidence: 'none' };
}

/**
 * Maneja la fase PARSE_SPECIALTY
 * @param {object} ctx - Contexto de la sesión (transcript, sessionId)
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function parseSpecialty(ctx, state) {
  const { transcript } = ctx;
  const { sessionId } = ctx;
  const cleanTranscript = (transcript || '').toLowerCase().trim();

  log("info", `[PARSE_SPECIALTY] Interpretando: "${cleanTranscript}"`);

  // 🎯 Consultar tabla Especialidad_Map en SQL Server
  const classification = await classifySpecialty(cleanTranscript);

  if (classification.found && classification.specialty) {
    // ✅ Especialidad identificada → avanzar directamente a CHECK_AVAILABILITY (HOY)
    state.especialidad = classification.specialty;
    state.specialtyAttempts = 0;

    // Forzar fecha HOY (no se pregunta)
    const today = new Date();
    state.fecha_solicitada = today.toISOString().split('T')[0]; // YYYY-MM-DD
    state.dateSource = 'FORCED_TODAY';
    state.rutPhase = 'CHECK_AVAILABILITY';

    log("info", `✅ [PARSE_SPECIALTY] Especialidad identificada: ${classification.specialty}, fecha forzada: HOY (${state.fecha_solicitada})`);

    // 🎯 REGLA: El TTS debe estar en la fase ANTERIOR que transiciona a la fase silenciosa
    // 🚀 OPTIMIZACIÓN DE LATENCIA (Prefetch)
    // Disparamos la búsqueda ahora mismo para que esté lista o avanzando en la sgte fase
    prefetchNextAvailability(state.rutFormatted, classification.specialty, sessionId);

    log("info", `🚀 [PARSE_SPECIALTY] Prefetch disparado. Transicionando INMEDIATAMENTE.`);

    return {
      ttsText: null, // ⚡ Sin TTS para transición instantánea (ahorra ~2s)
      nextPhase: 'CHECK_AVAILABILITY',
      shouldHangup: false,
      action: {
        type: "SET_STATE",
        payload: {
          updates: {
            especialidad: classification.specialty,
            fecha_solicitada: state.fecha_solicitada,
            dateSource: 'FORCED_TODAY',
            rutPhase: 'CHECK_AVAILABILITY'
          }
        }
      }
    };
  }

  // ❌ Especialidad no identificada → incrementar intentos
  state.specialtyAttempts = (state.specialtyAttempts || 0) + 1;
  log("warn", `⚠️ [PARSE_SPECIALTY] Especialidad no identificada. Intento #${state.specialtyAttempts}`);

  if (state.specialtyAttempts >= 3) {
    // Máximo de intentos → escalar
    return {
      ttsText: "No logro identificar la especialidad. Le transferiré con un ejecutivo.",
      nextPhase: 'FAILED',
      shouldHangup: true,
      action: {
        type: "END_CALL",
        payload: {
          reason: "FAILED",
          ttsText: "No logro identificar la especialidad. Le transferiré con un ejecutivo."
        }
      }
    };
  }

  // Repetir pregunta con ejemplos
  return {
    ttsText: "No entendí bien la especialidad. ¿Es para medicina general, control, odontología u otra especialidad?",
    nextPhase: 'PARSE_SPECIALTY',
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
