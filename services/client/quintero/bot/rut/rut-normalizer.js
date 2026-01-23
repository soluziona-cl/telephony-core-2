/**
 * 🔧 Normalizador de RUT
 * Convierte RUTs a formato estándar y genera lecturas enmascaradas para TTS
 */

import { normalizeRut, formatRut } from '../utils.js';

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

/**
 * 🎯 Extrae los últimos 4 dígitos + DV de un RUT formateado
 * Formato legacy: solo últimos 4 dígitos + DV (ej: "258-8")
 * @param {string} rutFormatted - RUT en formato "12.345.678-9" o "12345678-9"
 * @returns {string|null} - Últimos 4 dígitos + DV (ej: "258-8") o null si no se puede extraer
 */
export function getLast4DigitsAndDV(rutFormatted) {
  if (!rutFormatted) return null;
  
  // Limpiar puntos y espacios
  const cleanRut = rutFormatted.replace(/[.\s]/g, '');
  
  // Extraer body y DV (formato: "12345678-9" o "123456789")
  const match = cleanRut.match(/^(\d+)[-]?([0-9K])$/i);
  if (!match) return null;
  
  const body = match[1];
  const dv = match[2].toUpperCase();
  
  // Obtener últimos 4 dígitos del body
  const last4 = body.slice(-4);
  
  return `${last4}-${dv}`;
}

/**
 * 🎯 Genera lectura de confirmación para audio legacy
 * Formato: "tengo registrado el rut terminado en {últimos 4 dígitos + DV}"
 * @param {string} rutFormatted - RUT en formato "12.345.678-9" o "12345678-9"
 * @returns {string} - Texto para TTS (ej: "tengo registrado el rut terminado en dos cinco ocho guión ocho")
 */
export function getConfirmationReading(rutFormatted) {
  const last4AndDV = getLast4DigitsAndDV(rutFormatted);
  if (!last4AndDV) return "tengo registrado el rut terminado en desconocido";
  
  const [last4, dv] = last4AndDV.split('-');
  
  // Mapeo de dígitos a palabras
  const digitMap = {
    '0': 'cero', '1': 'uno', '2': 'dos', '3': 'tres', '4': 'cuatro',
    '5': 'cinco', '6': 'seis', '7': 'siete', '8': 'ocho', '9': 'nueve',
    'k': 'ka', 'K': 'ka'
  };
  
  const readDigits = (str) => str.split('').map(c => digitMap[c] || c).join(' ');
  
  return `tengo registrado el rut terminado en ${readDigits(last4)} guión ${digitMap[dv.toLowerCase()] || dv}. ¿Es correcto?`;
}

export default {
  normalize,
  format,
  getMaskedReading,
  getLast4DigitsAndDV,
  getConfirmationReading
};

