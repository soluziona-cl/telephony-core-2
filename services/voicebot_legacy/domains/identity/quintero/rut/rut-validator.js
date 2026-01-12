/**
 * ✅ Validador de RUT chileno
 * Valida matemáticamente el dígito verificador
 */

import { normalizeRut, isValidRut } from '../../../../shared/utils.js';

/**
 * Valida un RUT completo
 * @param {string} body - Cuerpo del RUT (sin DV)
 * @param {string} dv - Dígito verificador
 * @returns {boolean}
 */
export function validateRut(body, dv) {
  if (!body || !dv) return false;
  
  const rawRut = `${body}-${dv}`;
  const normalized = normalizeRut(rawRut);
  
  return isValidRut(normalized);
}

/**
 * Normaliza un RUT a formato estándar
 * @param {string} body - Cuerpo del RUT
 * @param {string} dv - Dígito verificador
 * @returns {string} - RUT normalizado (ej: "143482588")
 */
export function normalizeRutFull(body, dv) {
  if (!body || !dv) return null;
  
  const rawRut = `${body}-${dv}`;
  return normalizeRut(rawRut);
}

export default {
  validateRut,
  normalizeRutFull
};

