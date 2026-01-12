/**
 * 🔧 Normalizador de RUT
 * Convierte RUTs a formato estándar y genera lecturas enmascaradas para TTS
 */

import { normalizeRut, formatRut } from '../../../../shared/utils.js';

/**
 * Normaliza un RUT completo
 * @param {string} body - Cuerpo del RUT
 * @param {string} dv - Dígito verificador
 * @returns {string} - RUT normalizado sin puntos ni guiones
 */
export function normalize(body, dv) {
  if (!body || !dv) return null;
  const rawRut = `${body}-${dv}`;
  return normalizeRut(rawRut);
}

/**
 * Formatea un RUT para mostrar (con puntos y guión)
 * @param {string} body - Cuerpo del RUT
 * @param {string} dv - Dígito verificador
 * @returns {string} - RUT formateado (ej: "12.345.678-9")
 */
export function format(body, dv) {
  const normalized = normalize(body, dv);
  if (!normalized) return null;
  return formatRut(normalized);
}

/**
 * Genera lectura enmascarada del RUT para TTS
 * Solo muestra los últimos 3 dígitos del body + DV
 * @param {string} body - Cuerpo del RUT
 * @param {string} dv - Dígito verificador
 * @returns {string} - Lectura enmascarada (ej: "dos cinco ocho guión ocho")
 */
export function getMaskedReading(body, dv) {
  if (!body) return "desconocido";
  
  const last3 = body.toString().slice(-3);
  
  // Mapeo de dígitos a palabras
  const digitMap = {
    '0': 'cero', '1': 'uno', '2': 'dos', '3': 'tres', '4': 'cuatro',
    '5': 'cinco', '6': 'seis', '7': 'siete', '8': 'ocho', '9': 'nueve',
    'k': 'ka', 'K': 'ka'
  };
  
  const readDigits = (str) => str.split('').map(c => digitMap[c] || c).join(' ');
  
  return `${readDigits(last3)} guión ${digitMap[dv.toString().toLowerCase()] || dv}`;
}

export default {
  normalize,
  format,
  getMaskedReading
};

