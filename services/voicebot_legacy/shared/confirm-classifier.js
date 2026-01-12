/**
 * 🧠 Clasificador de Confirmación (Sí/No/Unknown)
 * Clasificador simple basado en diccionario, sin LLM
 * Usado para confirmaciones rápidas en flujos de validación
 */

import { log } from '../../../lib/logger.js';

/**
 * Clasifica una respuesta de confirmación en YES, NO o UNKNOWN
 * @param {string} transcript - Transcripción del usuario
 * @returns {string} - 'YES', 'NO' o 'UNKNOWN'
 */
export function classifyConfirm(transcript) {
  if (!transcript) return 'UNKNOWN';

  // 1. Normalización Semántica (Español + Inglés + Limpieza)
  // Elimina puntuación y mantiene solo letras y espacios
  const clean = transcript.toLowerCase().trim().replace(/[^\w\sáéíóúüñ]/g, '');

  // 2. Patrones Afirmativos (Multilenguaje)
  const affirmativePatterns = [
    // Español
    'si',
    'sí',
    'sii',
    'siii',
    'es correcto',
    'si es correcto',
    'y es correcto',
    'correcto',
    'asi es',
    'así es',
    'exacto',
    'claro',
    'bueno',
    'confirmo',
    'confirmado',
    'ok',
    'okay',
    'dale',
    'bueno ya',

    // Inglés (Soporte semántico)
    'yes',
    'yeah',
    'yep',
    'correct',
    'is correct',
    'it is correct',
    'he is correct',
    'that is correct',
    'ok',
    'sure',
    'right'
  ];

  // 3. Patrones Negativos (Multilenguaje)
  const negativePatterns = [
    // Español
    'no',
    'no es',
    'no es correcto',
    'incorrecto',
    'falso',
    'equivocado',
    'mal',
    'error',
    'corregir',
    'cambiar',
    'otro',

    // Inglés
    'no',
    'not',
    'is not',
    'incorrect',
    'wrong',
    'change'
  ];

  // 4. Verificación Estricta (Token Search)
  // Buscamos si el transcript normalizado CONTIENE alguna de las frases clave

  // Checking YES
  for (const pattern of affirmativePatterns) {
    // Check exact match or contained phrase bounded by spaces/start/end
    const regex = new RegExp(`(^|\\s)${pattern}(\\s|$)`, 'i');
    if (regex.test(clean)) {
      log('debug', `✅ [CONFIRM] Clasificado como YES (Patrón: "${pattern}"): "${transcript}"`);
      return 'YES';
    }
  }

  // Checking NO
  for (const pattern of negativePatterns) {
    const regex = new RegExp(`(^|\\s)${pattern}(\\s|$)`, 'i');
    if (regex.test(clean)) {
      log('debug', `❌ [CONFIRM] Clasificado como NO (Patrón: "${pattern}"): "${transcript}"`);
      return 'NO';
    }
  }

  // 5. Fallback Heurístico (solo si no matcheó nada explícito)
  if (/\bno\b/i.test(clean)) {
    log('debug', `❌ [CONFIRM] Clasificado como NO (Heurística "no"): "${transcript}"`);
    return 'NO';
  }

  log('debug', `❓ [CONFIRM] Clasificado como UNKNOWN: "${transcript}"`);
  return 'UNKNOWN';
}

/**
 * Alias para compatibilidad con código existente
 */
export function classifyConfirmSimple(transcript) {
  return classifyConfirm(transcript);
}

export default {
  classifyConfirm,
  classifyConfirmSimple
};

