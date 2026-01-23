/**
 * AUDIO MARKS — Segmentación lógica de audio continuo
 * 
 * Este módulo proporciona una capa explícita para marcar eventos temporales
 * en una grabación continua, permitiendo segmentación lógica sin cortar audio físico.
 * 
 * Principio: Las marcas son lógicas, no físicas. El audio nunca se corta en caliente.
 */

import { log } from "../../../lib/logger.js";
import redis from "../../../lib/redis.js";

/**
 * Tipos de marcas de audio
 */
export const AudioMarkType = {
  RECORDING_START: "RECORDING_START",
  LISTEN_START: "LISTEN_START",
  DELTA_ACTIVITY: "DELTA_ACTIVITY",
  COMPLETED_CHUNK: "COMPLETED_CHUNK",
  INTENT_FINALIZED: "INTENT_FINALIZED",
  TIMEOUT: "TIMEOUT",
};

/**
 * Inicializa el sistema de marcas de audio para un contexto
 * @param {Object} ctx - Contexto de la llamada (debe tener linkedId)
 */
export function initAudioMarks(ctx) {
  if (!ctx) {
    log("warn", "[AUDIO_MARKS] initAudioMarks: ctx es null/undefined");
    return;
  }

  ctx.audioMarks = [];
  ctx.audioTimebase = {
    startTs: Date.now(),
  };

  log("debug", `[AUDIO_MARKS] Inicializado para linkedId=${ctx.linkedId}`);
}

/**
 * Calcula el offset en milisegundos desde el inicio de la grabación
 * @param {Object} ctx - Contexto con audioTimebase
 * @returns {number} Offset en milisegundos
 */
export function nowOffsetMs(ctx) {
  if (!ctx?.audioTimebase?.startTs) {
    log("warn", "[AUDIO_MARKS] nowOffsetMs: audioTimebase no inicializado");
    return 0;
  }
  return Date.now() - ctx.audioTimebase.startTs;
}

/**
 * Emite una marca de audio y la registra
 * @param {Object} ctx - Contexto de la llamada
 * @param {Object} mark - Marca a emitir { type, reason, meta? }
 * @param {Function} logFn - Función de log (opcional, usa log por defecto)
 * @param {Object} redisClient - Cliente Redis (opcional, usa redis por defecto)
 */
export async function emitAudioMark(ctx, mark, logFn = log, redisClient = redis) {
  if (!ctx) {
    log("warn", "[AUDIO_MARKS] emitAudioMark: ctx es null/undefined");
    return;
  }

  if (!ctx.audioTimebase) {
    // Auto-inicializar si no existe (fallback defensivo)
    initAudioMarks(ctx);
  }

  const fullMark = {
    linkedId: ctx.linkedId,
    offsetMs: nowOffsetMs(ctx),
    type: mark.type,
    reason: mark.reason || "unknown",
    meta: mark.meta || {},
    timestamp: Date.now(),
  };

  // Guardar en memoria
  if (!ctx.audioMarks) {
    ctx.audioMarks = [];
  }
  ctx.audioMarks.push(fullMark);

  // Log explícito
  logFn("info", "[AUDIO_MARK]", fullMark);

  // Guardar en Redis (opcional, para persistencia)
  if (redisClient && ctx.linkedId) {
    try {
      // 🎯 @redis/client v4 usa camelCase: rPush (no rpush)
      await redisClient.rPush(
        `audio:marks:${ctx.linkedId}`,
        JSON.stringify(fullMark)
      );
      // TTL de 1 hora para las marcas
      await redisClient.expire(`audio:marks:${ctx.linkedId}`, 3600);
    } catch (err) {
      log("warn", `[AUDIO_MARKS] Error guardando marca en Redis: ${err.message}`);
    }
  }
}

/**
 * Obtiene todas las marcas de audio para un linkedId
 * @param {string} linkedId - ID de la llamada
 * @param {Object} redisClient - Cliente Redis (opcional)
 * @returns {Promise<Array>} Array de marcas
 */
export async function getAudioMarks(linkedId, redisClient = redis) {
  if (!linkedId || !redisClient) {
    return [];
  }

  try {
    // 🎯 @redis/client v4 usa camelCase: lRange (no lrange)
    const marksRaw = await redisClient.lRange(`audio:marks:${linkedId}`, 0, -1);
    return marksRaw.map(m => {
      try {
        return JSON.parse(m);
      } catch (e) {
        return null;
      }
    }).filter(m => m !== null);
  } catch (err) {
    log("warn", `[AUDIO_MARKS] Error obteniendo marcas de Redis: ${err.message}`);
    return [];
  }
}

/**
 * Limpia las marcas de audio de Redis (útil en cleanup)
 * @param {string} linkedId - ID de la llamada
 * @param {Object} redisClient - Cliente Redis (opcional)
 */
export async function clearAudioMarks(linkedId, redisClient = redis) {
  if (!linkedId || !redisClient) {
    return;
  }

  try {
    await redisClient.del(`audio:marks:${linkedId}`);
    log("debug", `[AUDIO_MARKS] Marcas limpiadas para linkedId=${linkedId}`);
  } catch (err) {
    log("warn", `[AUDIO_MARKS] Error limpiando marcas: ${err.message}`);
  }
}
