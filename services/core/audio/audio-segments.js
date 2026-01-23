/**
 * AUDIO SEGMENTS — Resolución de segmentos lógicos desde marcas
 * 
 * Convierte marcas de audio en segmentos auditables y extraíbles.
 * 
 * Principio: Un segmento = [LISTEN_START → INTENT_FINALIZED]
 */

import { log } from "../../../lib/logger.js";

/**
 * Resuelve segmentos de audio a partir de marcas
 * @param {Array<Object>} audioMarks - Array de marcas de audio
 * @returns {Array<Object>} Array de segmentos resueltos
 */
export function resolveAudioSegments(audioMarks) {
  if (!audioMarks || !Array.isArray(audioMarks) || audioMarks.length === 0) {
    return [];
  }

  const segments = [];
  let listenStart = null;

  for (const mark of audioMarks) {
    if (mark.type === "LISTEN_START") {
      listenStart = mark;
    }

    if (listenStart && mark.type === "INTENT_FINALIZED") {
      const segment = {
        startMs: listenStart.offsetMs,
        endMs: mark.offsetMs,
        durationMs: mark.offsetMs - listenStart.offsetMs,
        reason: mark.reason,
        meta: mark.meta || {},
        startMark: listenStart,
        endMark: mark,
      };

      segments.push(segment);
      listenStart = null; // Reset para siguiente segmento
    }
  }

  // Si hay un LISTEN_START sin INTENT_FINALIZED, crear segmento parcial
  if (listenStart) {
    const lastMark = audioMarks[audioMarks.length - 1];
    segments.push({
      startMs: listenStart.offsetMs,
      endMs: lastMark.offsetMs,
      durationMs: lastMark.offsetMs - listenStart.offsetMs,
      reason: "incomplete",
      meta: { note: "Segmento sin finalización explícita" },
      startMark: listenStart,
      endMark: lastMark,
    });
  }

  return segments;
}

/**
 * Obtiene el último segmento resuelto
 * @param {Array<Object>} audioMarks - Array de marcas
 * @returns {Object|null} Último segmento o null
 */
export function getLastSegment(audioMarks) {
  const segments = resolveAudioSegments(audioMarks);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

/**
 * Obtiene el segmento activo (si hay LISTEN_START sin INTENT_FINALIZED)
 * @param {Array<Object>} audioMarks - Array de marcas
 * @returns {Object|null} Segmento activo o null
 */
export function getActiveSegment(audioMarks) {
  if (!audioMarks || audioMarks.length === 0) {
    return null;
  }

  let listenStart = null;
  for (let i = audioMarks.length - 1; i >= 0; i--) {
    const mark = audioMarks[i];
    if (mark.type === "INTENT_FINALIZED") {
      return null; // Ya hay finalización
    }
    if (mark.type === "LISTEN_START") {
      listenStart = mark;
      break;
    }
  }

  if (!listenStart) {
    return null;
  }

  const lastMark = audioMarks[audioMarks.length - 1];
  return {
    startMs: listenStart.offsetMs,
    endMs: lastMark.offsetMs,
    durationMs: lastMark.offsetMs - listenStart.offsetMs,
    reason: "active",
    meta: { note: "Segmento en progreso" },
    startMark: listenStart,
    endMark: lastMark,
  };
}
