/**
 * 🔍 Parser de RUT desde transcripciones de voz
 * Extrae y normaliza RUTs desde texto hablado en español chileno
 */

import { parseRutFromSpeech, extractRutHard, cleanAsrNoise } from '../utils.js';

/**
 * Extrae un candidato de RUT desde una transcripción
 * @param {string} transcript - Transcripción del audio
 * @returns {object} - { body: string|null, dv: string|null, ok: boolean, reason: string }
 */
export function extractRutCandidate(transcript) {
  if (!transcript) {
    return { body: null, dv: null, ok: false, reason: 'empty' };
  }

  // Primero intentar regex fuerte (más rápido)
  const hardRut = extractRutHard(transcript);
  if (hardRut) {
    const body = hardRut.slice(0, -1);
    const dv = hardRut.slice(-1);
    return { body, dv, ok: true, reason: 'hard_regex' };
  }

  // Si falla, usar parser semántico
  const parsed = parseRutFromSpeech(transcript);
  
  if (parsed.ok && parsed.body && parsed.dv) {
    return {
      body: String(parsed.body),
      dv: parsed.dv,
      ok: true,
      reason: 'semantic_parser'
    };
  }

  // Si hay body pero falta DV
  if (parsed.body && !parsed.dv) {
    return {
      body: String(parsed.body),
      dv: null,
      ok: false,
      reason: 'missing_dv'
    };
  }

  // Intentar extraer body parcial desde ruido ASR
  const cleaned = cleanAsrNoise(transcript);
  const bodyMatch = cleaned.match(/(\d{1,2})[\s.-]?(\d{3})[\s.-]?(\d{3})/);
  
  if (bodyMatch) {
    const bodyCandidate = `${bodyMatch[1]}${bodyMatch[2]}${bodyMatch[3]}`;
    const bodyNum = parseInt(bodyCandidate, 10);
    
    if (bodyNum >= 100000 && bodyNum <= 99999999) {
      return {
        body: bodyCandidate,
        dv: null,
        ok: false,
        reason: 'partial_body'
      };
    }
  }

  return {
    body: parsed.body ? String(parsed.body) : null,
    dv: parsed.dv || null,
    ok: false,
    reason: parsed.reason || 'invalid_body'
  };
}

export default {
  extractRutCandidate
};

