/**
 * 🎯 IDENTITY CAPTURE MODULE (Genérico y Reutilizable)
 * 
 * Captura incremental de identificadores por voz (RUT, DNI, Nº deuda, etc.)
 * Agnóstico al dominio, tolerante al error, auditable.
 * 
 * Arquitectura:
 * - STT → Tokens (LIST) → Normalización → Evaluación → Estado
 * - Engine transporta eventos, Dominio decide negocio
 * 
 * Patrón reutilizable para:
 * - RUT (Chile)
 * - DNI (Argentina, otros)
 * - Nº deuda
 * - Nº contrato
 * - Cualquier identificador numérico por voz
 */

import { log } from "../../../lib/logger.js";
import redis from "../../../lib/redis.js";

/**
 * Estados canónicos de identidad (NO negociables)
 * 🎯 MEJORADO: Estados granulares para mejor control
 */
export const IdentityState = {
  INCOMPLETO: 'INCOMPLETO',           // No hay suficiente data (<7 dígitos)
  COMPLETO_SIN_DV: 'COMPLETO_SIN_DV', // Cuerpo válido (7-8 dígitos), DV pendiente
  DV_INVALIDO: 'DV_INVALIDO',         // Cuerpo válido pero DV incorrecto
  VALIDADO: 'VALIDADO',               // ✅ RUT completo y válido (cuerpo + DV correcto)
  INVALIDO: 'INVALIDO',               // Error definitivo (longitud inválida, etc.)
  // Estados legacy (compatibilidad)
  CUERPO_OK: 'COMPLETO_SIN_DV',       // Alias para compatibilidad
  DV_OK: 'DV_OK',                     // DV válido, cuerpo incompleto (casos raros)
  CONFIRMADO: 'VALIDADO'               // Alias para compatibilidad
};

/**
 * Configuración por tipo de identidad
 */
const IDENTITY_CONFIG = {
  RUT: {
    minLen: 7,
    maxLen: 8,
    dv: true,
    pattern: /^[0-9]{7,8}[0-9kK]$/,
    normalize: normalizeRutText
  },
  DNI: {
    minLen: 7,
    maxLen: 8,
    dv: false,
    pattern: /^[0-9]{7,8}$/,
    normalize: normalizeDigitsOnly
  },
  DEBT: {
    minLen: 6,
    maxLen: 12,
    dv: false,
    pattern: /^[0-9]{6,12}$/,
    normalize: normalizeDigitsOnly
  },
  CONTRACT: {
    minLen: 8,
    maxLen: 15,
    dv: false,
    pattern: /^[0-9]{8,15}$/,
    normalize: normalizeDigitsOnly
  }
};

/**
 * Normaliza texto a dígitos RUT (español)
 * 🎯 MEJORADO: Maneja fragmentos del STT (ej: "cu atro ientos" → "cuatrocientos")
 */
function normalizeRutText(text) {
  if (!text || typeof text !== 'string') return '';
  
  const clean = text.toLowerCase().trim();
  
  // Buscar dígitos directos primero
  const directDigits = clean.replace(/[^0-9kK]/g, '');
  if (directDigits.length >= 7) {
    return directDigits;
  }
  
  // 🎯 PASO 1: Reconstruir palabras fragmentadas del STT
  // El STT fragmenta palabras, necesitamos reconstruirlas
  let reconstructed = clean;
  
  // Patrones de fragmentación comunes del STT
  // El STT fragmenta palabras, necesitamos reconstruirlas ANTES de normalizar
  const fragmentPatterns = [
    // "cuatrocientos millones" fragmentado (CRÍTICO: aparece como "per im ill anes")
    { pattern: /\bper\s+im\s+ill\s+anes\b/gi, replacement: 'cuatrocientos millones' },
    // "catorce" fragmentado (CRÍTICO: aparece como "ator ce" o "Kat emi jiné" por STT mal transcrito)
    { pattern: /\bKat\s+emi\s+jin[ée]\b/gi, replacement: 'catorce' }, // "Kat emi jiné" → "catorce" (STT mal transcribe)
    { pattern: /\bKat\s+emi\b/gi, replacement: 'catorce' }, // "Kat emi" → "catorce" (fallback)
    { pattern: /\bKatolcemi\s+jin[ée]\b/gi, replacement: 'catorce' }, // "Katolcemi jiné" → "catorce"
    { pattern: /\bator\s+ce\b/gi, replacement: 'catorce' },
    { pattern: /\bca\s+torce\b/gi, replacement: 'catorce' },
    // "cuatrocientos" fragmentado (varios patrones)
    { pattern: /\bcu\s+atro\s+ientos\b/gi, replacement: 'cuatrocientos' },
    { pattern: /\bcu\s+atro\s+cientos\b/gi, replacement: 'cuatrocientos' },
    { pattern: /\bcuar\s+entos\b/gi, replacement: 'cuatrocientos' },
    { pattern: /\bcuar\s+ientos\b/gi, replacement: 'cuatrocientos' },
    { pattern: /\bcu\s+atrocientos\b/gi, replacement: 'cuatrocientos' },
    // "trescientos" fragmentado (incluye "resc" por STT mal transcrito)
    { pattern: /\bresc\s+ientos\b/gi, replacement: 'trescientos' }, // "resc ientos" → "trescientos" (STT mal transcribe "tres" como "resc")
    { pattern: /\bresc\s+cientos\b/gi, replacement: 'trescientos' }, // "resc cientos" → "trescientos"
    { pattern: /\btres\s+ientos\b/gi, replacement: 'trescientos' },
    { pattern: /\btres\s+cientos\b/gi, replacement: 'trescientos' },
    { pattern: /\bresc\s+ientos\b/gi, replacement: 'trescientos' }, // "resc ientos" → "trescientos" (STT mal transcribe "tres" como "resc")
    { pattern: /\bresc\s+cientos\b/gi, replacement: 'trescientos' }, // "resc cientos" → "trescientos"
    // "doscientos" fragmentado
    { pattern: /\bdos\s+ientos\b/gi, replacement: 'doscientos' },
    { pattern: /\bdos\s+cientos\b/gi, replacement: 'doscientos' },
    // "cuarenta" fragmentado
    { pattern: /\bcuar\s+enta\b/gi, replacement: 'cuarenta' },
    { pattern: /\bcu\s+arenta\b/gi, replacement: 'cuarenta' },
    // "cincuenta" fragmentado
    { pattern: /\bcinc\s+uenta\b/gi, replacement: 'cincuenta' },
    { pattern: /\bcinc\s+enta\b/gi, replacement: 'cincuenta' },
    // "cuatro" fragmentado
    { pattern: /\bcu\s+atro\b/gi, replacement: 'cuatro' },
    // "millones" fragmentado
    { pattern: /\bmil\s+lones\b/gi, replacement: 'millones' },
    { pattern: /\bmil\s+ones\b/gi, replacement: 'millones' },
    { pattern: /\bim\s+ill\s+anes\b/gi, replacement: 'millones' },
    // 🎯 FIX E: Unir fragmentos comunes adicionales (sin duplicar los ya definidos arriba)
    { pattern: /\bcuatro\s+cientos\b/gi, replacement: 'cuatrocientos' }, // "cuatro cientos" → "cuatrocientos"
    { pattern: /\bquin\s+ientos\b/gi, replacement: 'quinientos' }, // "quin ientos" → "quinientos"
    { pattern: /\bseis\s+ientos\b/gi, replacement: 'seiscientos' }, // "seis ientos" → "seiscientos"
    { pattern: /\bsete\s+cientos\b/gi, replacement: 'setecientos' }, // "sete cientos" → "setecientos"
    { pattern: /\bocho\s+cientos\b/gi, replacement: 'ochocientos' }, // "ocho cientos" → "ochocientos"
    { pattern: /\bnove\s+cientos\b/gi, replacement: 'novecientos' } // "nove cientos" → "novecientos"
  ];
  
  for (const { pattern, replacement } of fragmentPatterns) {
    reconstructed = reconstructed.replace(pattern, replacement);
  }
  
  // Normalizar espacios múltiples
  reconstructed = reconstructed.replace(/\s+/g, ' ').trim();
  
  // 🎯 PASO 2: Convertir número hablado completo a dígitos
  // Estrategia: Usar lógica similar a parseRutFromSpeech para convertir números hablados completos
  // Esto maneja correctamente "cuatrocientos millones trescientos cuarenta y ocho mil doscientos cincuenta y ocho"
  
  // Mapeo de palabras a valores numéricos (para construir el número completo)
  const WORD_NUM = {
    "cero": 0, "un": 1, "uno": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4,
    "cinco": 5, "seis": 6, "siete": 7, "ocho": 8, "nueve": 9,
    "diez": 10, "once": 11, "doce": 12, "trece": 13, "catorce": 14, "quince": 15,
    "dieciseis": 16, "dieciséis": 16, "diecisiete": 17, "dieciocho": 18, "diecinueve": 19,
    "veinte": 20, "veintiuno": 21, "veintiuna": 21, "veintidos": 22, "veintidós": 22,
    "veintitres": 23, "veintitrés": 23, "veinticuatro": 24, "veinticinco": 25,
    "veintiseis": 26, "veintiséis": 26, "veintisiete": 27, "veintiocho": 28, "veintinueve": 29,
    "treinta": 30, "cuarenta": 40, "cincuenta": 50, "sesenta": 60,
    "setenta": 70, "ochenta": 80, "noventa": 90,
    "cien": 100, "ciento": 100,
    "doscientos": 200, "trescientos": 300, "cuatrocientos": 400,
    "quinientos": 500, "seiscientos": 600, "setecientos": 700,
    "ochocientos": 800, "novecientos": 900
  };
  
  // Helper para parsear un grupo de tokens a número
  // 🎯 FIX CRÍTICO: Usar lógica probada de utils.js (suma directa para números compuestos)
  function parseGroup(tokens, wordMap) {
    if (tokens.length === 0) return 0;
    
    // Si viene un número directo
    if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
      return parseInt(tokens[0], 10);
    }
    
    // 🎯 ESTRATEGIA: Detectar si es secuencia de dígitos sueltos
    // Secuencia: "tres cuatro ocho" → "348"
    let allSingleDigits = true;
    let seq = "";
    for (const t of tokens) {
      if (t === "y") continue; // Ignorar "y"
      const value = wordMap[t];
      if (value !== undefined && value >= 0 && value <= 9) {
        seq += String(value);
      } else if (/^\d$/.test(t)) {
        seq += t;
      } else {
        allSingleDigits = false;
        break;
      }
    }
    if (allSingleDigits && seq.length >= 2) {
      return parseInt(seq, 10);
    }
    
    // 🎯 Parse composicional (suma directa - misma lógica que utils.js)
    // Ejemplo: "trescientos cuarenta y ocho" → 300 + 40 + 8 = 348
    let total = 0;
    for (const t of tokens) {
      if (t === "y") continue; // Ignorar conectores
      if (/^\d+$/.test(t)) {
        total += parseInt(t, 10);
      } else if (wordMap[t] !== undefined) {
        const v = wordMap[t];
        if (typeof v === "number") {
          total += v;
        }
      }
    }
    return total;
  }
  
  // Dividir texto en tokens y filtrar palabras no numéricas
  const tokens = reconstructed.split(/\s+/).filter(t => {
    const clean = t.toLowerCase().trim();
    return clean.length > 0 && clean !== 'y' && clean !== '.' && clean !== ',';
  });
  
  // 🎯 ESTRATEGIA DUAL:
  // 1. Si hay palabras de estructura (millones, mil), parsear como número completo
  // 2. Si NO hay estructura, tratar cada palabra numérica como dígito individual
  
  const hasStructure = tokens.some(t => 
    ['millones', 'millón', 'millon', 'mil'].includes(t.toLowerCase())
  );
  
  if (hasStructure) {
    // Parsear estructura con millones/mil (números grandes)
    // 🎯 FIX CRÍTICO: Manejar correctamente "catorce millones trescientos cuarenta y ocho mil doscientos cincuenta y uno"
    let millions = 0;
    let thousands = 0;
    let rest = 0;
    
    let buf = [];
    let foundMillion = false;
    let foundThousand = false;
    
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].toLowerCase();
      
      if (t === "millones" || t === "millón" || t === "millon") {
        if (buf.length > 0) {
          millions = parseGroup(buf, WORD_NUM);
        } else {
          millions = 1;
        }
        buf = [];
        foundMillion = true;
        continue;
      }
      
      if (t === "mil") {
        if (buf.length > 0) {
          // 🎯 FIX: Parsear el buffer antes de "mil" como thousands
          // Ejemplo: "trescientos cuarenta y dos mil" → thousands = 342
          thousands = parseGroup(buf, WORD_NUM) || 1;
        } else if (thousands === 0) {
          // Solo asignar 1 si no hay buf y no hay thousands previo
          thousands = 1;
        }
        // Si ya hay thousands (asignado en línea 264 antes de llegar "mil"), mantenerlo
        buf = [];
        foundThousand = true;
        continue;
      }
      
      if (WORD_NUM[t] !== undefined || /^\d+$/.test(t)) {
        buf.push(t);
      }
    }
    
    // 🎯 FIX CRÍTICO: Lógica correcta para determinar dónde va el buffer restante
    // NOTA: Si ya se procesó "mil" en el loop, thousands ya está asignado del buf antes de "mil"
    if (foundThousand && buf.length > 0) {
      // Caso: "...mil doscientos..." (ya pasó "mil")
      // El buffer actual va a rest
      rest = parseGroup(buf, WORD_NUM);
    } else if (foundMillion && !foundThousand && buf.length > 0) {
      // Caso: "catorce millones trescientos..." (aún no llegó "mil")
      // El buffer actual va a miles, no a rest
      // NOTA: Esto solo se ejecuta si "mil" nunca llegó en el loop
      // Si ya hay thousands (asignado antes), no reemplazarlo
      if (thousands === 0) {
        thousands = parseGroup(buf, WORD_NUM);
      }
    } else if (!foundMillion && !foundThousand && buf.length > 0) {
      // Caso: sin estructura, todo va a rest
      rest = parseGroup(buf, WORD_NUM);
    }
    
    const fullNumber = (millions * 1_000_000) + (thousands * 1_000) + rest;
    const result = fullNumber.toString().replace(/[^0-9]/g, '');
    
    // 🎯 FIX: Si el resultado es muy grande (>8 dígitos), NO truncar - dejar que el webhook lo valide
    // El truncamiento puede causar pérdida de información crítica
    // El webhook es quien debe decidir si es válido o no
    if (result.length > 8) {
      log("warn", `⚠️ [NORMALIZE] RUT tiene ${result.length} dígitos (más de 8): ${result} - El webhook validará`);
      // NO truncar - dejar que el webhook lo procese
      return result;
    }
    
    return result;
  } else {
    // 🎯 MODO DÍGITO POR DÍGITO: Cada palabra numérica es un dígito
    // Ejemplo: "catorce tres cuatro ocho dos cinco" → "1434825"
    const digitMap = {
      "cero": "0", "un": "1", "uno": "1", "una": "1", "dos": "2", "tres": "3", "cuatro": "4",
      "cinco": "5", "seis": "6", "siete": "7", "ocho": "8", "nueve": "9",
      "diez": "10", "once": "11", "doce": "12", "trece": "13", "catorce": "14", "quince": "15",
      "dieciseis": "16", "dieciséis": "16", "diecisiete": "17", "dieciocho": "18", "diecinueve": "19",
      "veinte": "20", "veintiuno": "21", "veintiuna": "21", "veintidos": "22", "veintidós": "22",
      "veintitres": "23", "veintitrés": "23", "veinticuatro": "24", "veinticinco": "25",
      "veintiseis": "26", "veintiséis": "26", "veintisiete": "27", "veintiocho": "28", "veintinueve": "29",
      "treinta": "30", "cuarenta": "40", "cincuenta": "50", "sesenta": "60",
      "setenta": "70", "ochenta": "80", "noventa": "90",
      "cien": "100", "ciento": "100",
      "doscientos": "200", "trescientos": "300", "cuatrocientos": "400",
      "quinientos": "500", "seiscientos": "600", "setecientos": "700",
      "ochocientos": "800", "novecientos": "900"
    };
    
    const digits = [];
    for (const token of tokens) {
      const t = token.toLowerCase();
      if (digitMap[t]) {
        // Convertir número a dígitos (ej: "14" → "14", "3" → "3")
        digits.push(digitMap[t]);
      } else if (/^\d+$/.test(t)) {
        // Ya es un dígito
        digits.push(t);
      }
    }
    
    // Concatenar todos los dígitos
    return digits.join('');
  }
}

/**
 * Normaliza texto a solo dígitos (para DNI, deuda, etc.)
 */
function normalizeDigitsOnly(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/[^0-9]/g, '');
}

/**
 * Filtra tokens inválidos antes de push
 * 🎯 MEJORA 5: Filtro mejorado con blacklist dinámica
 */
/**
 * 🎯 FILTRO ESTRICTO: Solo acepta palabras numéricas válidas en español
 * 
 * Durante LISTEN_RUT, solo se acumulan tokens semánticos válidos.
 * NO se acepta ruido, fragmentos fonéticos, ni caracteres no numéricos.
 * 
 * @param {string} token - Token a validar
 * @param {string} type - Tipo de identidad ('RUT', 'DNI', etc.)
 * @returns {boolean} true si el token es una palabra numérica válida
 */
function isPotentialIdentityToken(token, type = 'RUT') {
  if (!token || typeof token !== 'string') return false;

  const clean = token.trim().toLowerCase();
  if (clean.length === 0) return false;

  // 🎯 FILTRO ESTRICTO: Solo palabras numéricas válidas en español
  const VALID_RUT_WORDS = [
    // Dígitos básicos
    "cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
    // 10-19
    "diez", "once", "doce", "trece", "catorce", "quince", 
    "dieciseis", "dieciséis", "diecisiete", "dieciocho", "diecinueve",
    // Decenas
    "veinte", "veintiuno", "veintiuna", "veintidos", "veintidós", "veintitres", "veintitrés",
    "veinticuatro", "veinticinco", "veintiseis", "veintiséis", "veintisiete", "veintiocho", "veintinueve",
    "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa",
    // Centenas
    "cien", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos",
    "seiscientos", "setecientos", "ochocientos", "novecientos",
    // Multiplicadores
    "mil", "millones", "millon", "millón",
    // Conectores (solo "y" entre decenas y unidades)
    "y"
  ];

  // Si tiene dígitos directos, es válido
  if (/^\d+$/.test(clean)) return true;

  // Verificar si es una palabra numérica válida
  if (VALID_RUT_WORDS.includes(clean)) return true;

  // 🎯 FIX E: Permitir fragmentos comunes que se reconstruyen (ej: "ator ce" → "catorce")
  // Pero solo si son fragmentos conocidos que se unen en palabras numéricas válidas
  const validFragments = [
    'ator', 'ce', 'tor', 'atro', 'ientos', 'enta', 'uenta', 
    'cinc', 'resc', 'cuar', 'int', 'icin'
  ];
  if (validFragments.includes(clean)) return true;

  // 🚫 RECHAZAR TODO LO DEMÁS
  // Caracteres especiales, puntuación, ruido multilenguaje, palabras no numéricas, etc.
  // Ejemplos de ruido que se debe rechazar:
  // - "Entrechónit", "prajaoč", "հարցիս", "to", "pra", "Entre", "ch", "ón", "it"
  // - Cualquier carácter no ASCII que no sea español
  // - Puntuación sola (".", ",", etc.)
  
  // Rechazar caracteres no ASCII (ruido multilenguaje)
  if (!/^[a-záéíóúñü0-9]+$/i.test(clean)) return false;
  
  // Rechazar tokens de 1-2 caracteres que no sean fragmentos válidos ni dígitos
  if (clean.length <= 2 && !validFragments.includes(clean) && !/^\d+$/.test(clean)) return false;
  
  return false;
}

/**
 * Calcula score de confianza (0-100)
 */
function calculateConfidence(normalized, tokens, type, state) {
  let score = 0;
  const config = IDENTITY_CONFIG[type];
  
  if (!config) return 0;
  
  // Longitud correcta
  if (normalized.length >= config.minLen && normalized.length <= config.maxLen) {
    score += 30;
  } else if (normalized.length >= config.minLen - 1) {
    score += 15; // Casi completo
  }
  
  // DV válido (si aplica)
  if (config.dv && state === IdentityState.CONFIRMADO) {
    score += 30;
  }
  
  // Estabilidad de tokens (menos tokens = más estable)
  const tokenRatio = tokens.length / Math.max(normalized.length, 1);
  if (tokenRatio < 2) {
    score += 20; // Muy estable
  } else if (tokenRatio < 3) {
    score += 10; // Moderadamente estable
  }
  
  // Repetición consistente (si el último token coincide con el anterior)
  if (tokens.length >= 2) {
    const lastTwo = tokens.slice(-2);
    if (lastTwo[0] === lastTwo[1]) {
      score += 20; // Repetición (puede ser confirmación)
    }
  }
  
  return Math.min(100, score);
}

/**
 * Valida RUT con módulo 11 (algoritmo canónico)
 * 🎯 MEJORADO: Maneja RUTs con y sin DV explícito
 * 
 * @param {string} rut - RUT completo (con o sin DV)
 * @param {string} dvExplicit - DV explícito (opcional, si viene separado)
 * @returns {Object} { valid: boolean, dv: string, expected: string, received: string, body: string }
 */
function validateRutDv(rut, dvExplicit = null) {
  if (!rut) return { valid: false, dv: null, expected: null, received: null, body: null };
  
  // Si viene DV explícito, usarlo
  const dv = dvExplicit ? dvExplicit.toUpperCase() : (rut.length >= 8 ? rut.slice(-1).toUpperCase() : null);
  const body = dvExplicit ? rut : (rut.length >= 8 ? rut.slice(0, -1) : rut);
  
  // Validar que el cuerpo tenga 7-8 dígitos
  if (!/^\d{7,8}$/.test(body)) {
    return { valid: false, dv: null, expected: null, received: dv, body };
  }
  
  // Calcular DV con módulo 11
  let sum = 0;
  let multiplier = 2;
  
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  
  const remainder = 11 - (sum % 11);
  let calculatedDv;
  
  if (remainder === 11) {
    calculatedDv = '0';
  } else if (remainder === 10) {
    calculatedDv = 'K';
  } else {
    calculatedDv = remainder.toString();
  }
  
  // Si no hay DV recibido, retornar el esperado
  if (!dv) {
    return {
      valid: false,
      dv: null,
      expected: calculatedDv,
      received: null,
      body
    };
  }
  
  return {
    valid: calculatedDv === dv,
    dv: calculatedDv,
    expected: calculatedDv,
    received: dv,
    body
  };
}

/**
 * 🎯 EVALUADOR DE CIERRE SEMÁNTICO
 * Determina si una identidad está completa y lista para commit
 * 
 * Criterios canónicos:
 * A. Normalización numérica válida
 * B. Longitud válida (7-8 dígitos para RUT)
 * C. Dígito verificador válido (si aplica)
 * D. Estabilidad temporal (no cambia en 2 ventanas consecutivas)
 * 
 * @param {string} sessionId - ID de sesión
 * @param {string} type - Tipo de identidad
 * @returns {Promise<Object>} { isComplete: boolean, reason: string, normalized: string, confidence: number }
 */
export async function evaluateIdentityBuffer(sessionId, type = 'RUT') {
  if (!sessionId) {
    return { isComplete: false, reason: 'no_session', normalized: null, confidence: 0 };
  }
  
  const config = IDENTITY_CONFIG[type];
  if (!config) {
    return { isComplete: false, reason: 'invalid_type', normalized: null, confidence: 0 };
  }
  
  const tokensKey = `id:${type}:tokens:${sessionId}`;
  const normalizedKey = `id:${type}:normalized:${sessionId}`;
  const stateKey = `id:${type}:state:${sessionId}`;
  const confidenceKey = `id:${type}:confidence:${sessionId}`;
  const partialKey = `id:${type}:partial:${sessionId}`;
  const stabilityKey = `id:${type}:stability:${sessionId}`;
  const lastValueKey = `id:${type}:lastValue:${sessionId}`;
  
  // Obtener estado actual
  const tokens = await redis.lRange(tokensKey, 0, -1) || [];
  const normalized = await redis.get(normalizedKey) || '';
  const partial = await redis.get(partialKey) || '';
  
  // 🎯 CRITERIO A: Normalización numérica válida
  if (!normalized || normalized.length === 0) {
    return { isComplete: false, reason: 'no_normalized', normalized: null, confidence: 0 };
  }
  
  // 🎯 CRITERIO B: Longitud válida
  if (normalized.length < config.minLen) {
    return { 
      isComplete: false, 
      reason: `length_insufficient:${normalized.length}<${config.minLen}`, 
      normalized, 
      confidence: 0 
    };
  }
  
  if (normalized.length > config.maxLen + 1) { // +1 para DV
    return { 
      isComplete: false, 
      reason: `length_overflow:${normalized.length}>${config.maxLen + 1}`, 
      normalized, 
      confidence: 0 
    };
  }
  
  // 🎯 CRITERIO C: Dígito verificador (si aplica)
  // Buscar DV explícito en el texto parcial (hablado: "k", "ka", "eme", "nueve", etc.)
  let dvExplicit = null;
  let dvInfo = null;
  let dvValid = true;
  
  if (config.dv) {
    // Buscar DV en el texto parcial
    const partialLower = partial.toLowerCase();
    
    // Mapeo de palabras DV habladas
    const dvMap = {
      'k': 'K', 'ka': 'K', 'cabe': 'K', 'eme': 'K',
      'cero': '0', 'uno': '1', 'dos': '2', 'tres': '3', 'cuatro': '4',
      'cinco': '5', 'seis': '6', 'siete': '7', 'ocho': '8', 'nueve': '9'
    };
    
    // Buscar patrones: "guión k", "raya ocho", "dv nueve", etc.
    const dvPatterns = [
      /\bgu[íi]on\s+(k|ka|cabe|eme|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b/gi,
      /\braya\s+(k|ka|cabe|eme|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b/gi,
      /\bdv\s+(k|ka|cabe|eme|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b/gi,
      /\bverificador\s+(k|ka|cabe|eme|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b/gi
    ];
    
    for (const pattern of dvPatterns) {
      const match = partialLower.match(pattern);
      if (match) {
        const dvWord = match[0].split(/\s+/).pop();
        dvExplicit = dvMap[dvWord] || dvWord.toUpperCase();
        break;
      }
    }
    
    // Si no se encontró explícito, buscar al final del normalized (si tiene 8-9 caracteres)
    if (!dvExplicit && normalized.length >= 8) {
      const lastChar = normalized.slice(-1).toUpperCase();
      if (lastChar === 'K' || /^[0-9]$/.test(lastChar)) {
        dvExplicit = lastChar;
      }
    }
    
    // Validar DV
    if (normalized.length >= config.minLen) {
      dvInfo = validateRutDv(normalized, dvExplicit);
      
      if (normalized.length >= 8 && dvInfo.dv) {
        // Tiene DV, validar
        dvValid = dvInfo.valid;
      } else if (normalized.length >= config.minLen && normalized.length < 8) {
        // Cuerpo válido pero DV pendiente
        dvValid = false;
        if (dvInfo.expected) {
          // Ya podemos calcular el DV esperado
          dvInfo = { valid: false, dv: null, expected: dvInfo.expected, received: null, body: normalized };
        }
      }
    }
  }
  
  // 🎯 CRITERIO D: Estabilidad temporal
  // Verificar si el valor ha sido estable en las últimas 2 ventanas (500ms cada una)
  const WINDOW_MS = 500;
  const STABLE_COUNT = 2;
  
  const lastValue = await redis.get(lastValueKey);
  const stabilityData = await redis.get(stabilityKey);
  
  let stabilityCount = 0;
  let isStable = false;
  
  if (stabilityData) {
    try {
      const stability = JSON.parse(stabilityData);
      stabilityCount = stability.count || 0;
      const lastUpdate = stability.lastUpdate || 0;
      const now = Date.now();
      
      // Si el valor no ha cambiado y ha pasado menos de 1 segundo desde la última actualización
      if (lastValue === normalized && (now - lastUpdate) < 1000) {
        stabilityCount++;
      } else if (lastValue !== normalized) {
        // Valor cambió, resetear contador
        stabilityCount = 1;
      }
      
      isStable = stabilityCount >= STABLE_COUNT;
    } catch (e) {
      // Si hay error parseando, asumir inestable
      stabilityCount = 1;
    }
  } else {
    // Primera evaluación
    stabilityCount = 1;
  }
  
  // Actualizar tracking de estabilidad
  // 🎯 FIX: Protección defensiva - no actualizar si normalized es undefined o no es string
  if (normalized && typeof normalized === 'string') {
    await redis.set(lastValueKey, normalized, { EX: 60 });
  }
  await redis.set(stabilityKey, JSON.stringify({
    count: stabilityCount,
    lastUpdate: Date.now()
  }), { EX: 60 });
  
  // 🎯 MEJORA 3: Estabilidad temporal más estricta para RUT
  // Para RUT: requiere estabilidad real (no solo longitud)
  // Para otros tipos: más permisivo
  let hasStability;
  if (config.dv && type === 'RUT') {
    // RUT: requiere estabilidad real (2 ventanas consecutivas)
    hasStability = isStable && stabilityCount >= 2;
  } else {
    // DEBT/CONTRACT: más permisivo
    hasStability = isStable || normalized.length >= config.minLen;
  }
  
  // 🎯 FIX D: Regla ">8 dígitos = incluye DV" - separar body y DV antes de validar
  let bodyForDv = normalized;
  let dvForValidation = null;
  if (normalized.length > 8 && config.dv) {
    // Asumir que el último dígito es DV
    bodyForDv = normalized.slice(0, -1);
    dvForValidation = normalized.slice(-1);
    log("debug", `🔍 [IDENTITY CAPTURE] normalized.length=${normalized.length} > 8, separando: body="${bodyForDv}", dv="${dvForValidation}"`);
    
    // Re-validar DV con el body separado
    if (bodyForDv.length >= config.minLen && bodyForDv.length <= config.maxLen) {
      const dvInfoSeparated = validateRutDv(bodyForDv, dvForValidation); // 🎯 FIX: validateRutDv solo acepta 2 parámetros
      if (dvInfoSeparated.valid) {
        // DV válido con body separado - usar body como normalized
        normalized = bodyForDv;
        dvValid = true;
        dvInfo = dvInfoSeparated;
        log("info", `✅ [IDENTITY CAPTURE] DV válido después de separar: body="${bodyForDv}", dv="${dvForValidation}"`);
      } else {
        log("debug", `⚠️ [IDENTITY CAPTURE] DV inválido después de separar: body="${bodyForDv}", dv="${dvForValidation}", expected="${dvInfoSeparated.expected}"`);
      }
    }
  }
  
  // 🎯 EVALUACIÓN FINAL CON ESTADOS GRANULARES
  const hasValidLength = normalized.length >= config.minLen && normalized.length <= (config.maxLen + (config.dv ? 1 : 0));
  const hasValidDv = !config.dv || dvValid;
  
  // Determinar estado granular
  let finalState = IdentityState.INCOMPLETO;
  if (hasValidLength) {
    if (config.dv) {
      if (dvValid && dvInfo?.valid) {
        finalState = IdentityState.VALIDADO; // ✅ RUT completo y válido
      } else if (normalized.length >= 8 && !dvValid) {
        finalState = IdentityState.DV_INVALIDO; // Cuerpo válido pero DV incorrecto
      } else if (normalized.length >= config.minLen && normalized.length < 8) {
        finalState = IdentityState.COMPLETO_SIN_DV; // Cuerpo válido, DV pendiente
      }
    } else {
      // Sin DV: si tiene longitud correcta, está validado
      finalState = IdentityState.VALIDADO;
    }
  } else if (normalized.length > config.maxLen + 1) {
    finalState = IdentityState.INVALIDO;
  }
  
  // Solo considerar completo si está VALIDADO Y tiene estabilidad
  const isComplete = finalState === IdentityState.VALIDADO && hasStability;
  
  // Calcular confidence
  let confidence = calculateConfidence(
    normalized, 
    tokens, 
    type, 
    finalState
  );
  
  // Ajustar confidence basado en estabilidad y DV
  if (isStable) {
    confidence = Math.min(100, confidence + 10);
  }
  if (dvValid && dvInfo?.valid) {
    confidence = Math.min(100, confidence + 30);
  }
  
  // Determinar razón
  let reason = 'complete';
  if (!hasValidLength) {
    reason = `length_invalid:${normalized.length}`;
  } else if (config.dv && !dvValid && normalized.length >= 8) {
    reason = `dv_invalid:expected=${dvInfo?.expected},received=${dvInfo?.received}`;
  } else if (config.dv && normalized.length < 8) {
    reason = `dv_pending:expected=${dvInfo?.expected || '?'}`;
  } else if (!hasStability) {
    reason = `unstable:count=${stabilityCount}`;
  }
  
  log("info", `🔍 [IDENTITY EVALUATOR] sessionId=${sessionId}, type=${type}, normalized="${normalized}", length=${normalized.length}, state=${finalState}, dvValid=${dvValid}, dvExpected=${dvInfo?.expected || 'N/A'}, stable=${isStable}, isComplete=${isComplete}, reason=${reason}, confidence=${confidence}`);
  
  return {
    isComplete,
    reason,
    normalized,
    confidence,
    dvInfo,
    stabilityCount,
    hasValidLength,
    hasValidDv,
    hasStability,
    state: finalState,
    dvExplicit
  };
}

/**
 * Procesa un delta de STT y actualiza el estado de identidad
 * 
 * @param {string} sessionId - ID de sesión
 * @param {string} rawText - Delta de texto del STT
 * @param {string} type - Tipo de identidad ('RUT', 'DNI', 'DEBT', 'CONTRACT')
 * @returns {Promise<Object>} Estado actualizado de la identidad
 */
/**
 * Procesa un delta de identidad (token incremental)
 * 
 * @param {string} sessionId - ID de sesión
 * @param {string} rawText - Texto del delta o transcripción completa
 * @param {string} type - Tipo de identidad ('RUT', 'DNI', etc.)
 * @param {boolean} shouldEvaluate - Si true, ejecuta evaluación. Si false (default para deltas), solo acumula tokens
 * @returns {Promise<Object>} Estado de la identidad
 */
export async function processIdentityDelta(sessionId, rawText, type = 'RUT', shouldEvaluate = false) {
  if (!sessionId || !rawText) {
    return {
      state: IdentityState.INCOMPLETO,
      normalized: null,
      confidence: 0,
      tokens: []
    };
  }
  
  // 🎯 MEJORA 1: Congelar identidad al VALIDADO - ignorar todo input posterior
  const frozenKey = `id:${type}:frozen:${sessionId}`;
  const isFrozen = await redis.get(frozenKey);
  if (isFrozen) {
    log("debug", `🔒 [IDENTITY CAPTURE] Identidad congelada (VALIDADO), ignorando input posterior: "${rawText}"`);
    // Retornar estado actual sin cambios
    const tokensKey = `id:${type}:tokens:${sessionId}`;
    const normalizedKey = `id:${type}:normalized:${sessionId}`;
    const stateKey = `id:${type}:state:${sessionId}`;
    const confidenceKey = `id:${type}:confidence:${sessionId}`;
    const currentTokens = await redis.lRange(tokensKey, 0, -1) || [];
    const currentNormalized = await redis.get(normalizedKey) || '';
    const currentState = await redis.get(stateKey) || IdentityState.VALIDADO;
    const currentConfidence = parseInt(await redis.get(confidenceKey) || '0', 10);
    
    return {
      state: currentState,
      normalized: currentNormalized || null,
      confidence: currentConfidence,
      tokens: currentTokens
    };
  }
  
  const config = IDENTITY_CONFIG[type];
  if (!config) {
    log("error", `❌ [IDENTITY CAPTURE] Tipo de identidad no soportado: ${type}`);
    return {
      state: IdentityState.INVALIDO,
      normalized: null,
      confidence: 0,
      tokens: [],
      reason: `Tipo no soportado: ${type}`
    };
  }
  
  const tokensKey = `id:${type}:tokens:${sessionId}`;
  const normalizedKey = `id:${type}:normalized:${sessionId}`;
  const stateKey = `id:${type}:state:${sessionId}`;
  const confidenceKey = `id:${type}:confidence:${sessionId}`;
  const partialKey = `id:${type}:partial:${sessionId}`;
  
  // 🎯 FILTRO PREVIO: Ignorar tokens inválidos
  const trimmedDelta = rawText.trim();
  if (!isPotentialIdentityToken(trimmedDelta, type)) {
    log("debug", `🚫 [IDENTITY CAPTURE] Token ignorado (ruido): "${trimmedDelta}"`);
    // Retornar estado actual sin cambios
    const currentTokens = await redis.lRange(tokensKey, 0, -1) || [];
    const currentNormalized = await redis.get(normalizedKey) || '';
    const currentState = await redis.get(stateKey) || IdentityState.INCOMPLETO;
    const currentConfidence = parseInt(await redis.get(confidenceKey) || '0', 10);
    
    return {
      state: currentState,
      normalized: currentNormalized || null,
      confidence: currentConfidence,
      tokens: currentTokens
    };
  }
  
  // 🎯 PUSH: Agregar token a la LIST
  await redis.rPush(tokensKey, trimmedDelta);
  await redis.expire(tokensKey, 60);
  
  // 🎯 ENSAMBLAR: Obtener todos los tokens
  const tokens = await redis.lRange(tokensKey, 0, -1) || [];
  const fullText = tokens.join(' ');

  // Actualizar cache de texto parcial (solo para referencia, NO para normalización)
  await redis.set(partialKey, fullText, { EX: 60 });

  // 🎯 ARQUITECTURA CORRECTA: NO normalizar durante LISTEN_RUT
  // La normalización solo ocurre en el webhook cuando hay silencio
  // Redis solo acumula tokens semánticos válidos, sin convertir a números
  // 
  // NO llamar a config.normalize() aquí - eso lo hace el webhook
  // NO calcular normalized - eso lo hace el webhook
  // NO truncar - eso lo hace el webhook
  // NO validar DV - eso lo hace el webhook
  
  log("debug", `📝 [IDENTITY CAPTURE] Token pushed: "${trimmedDelta}" -> tokens=${tokens.length} (sin normalizar - el webhook lo hará cuando haya silencio)`);
  
  // 🎯 ARQUITECTURA CORRECTA: Redis solo acumula tokens semánticos, webhook valida
  // El engine NO normaliza, NO evalúa, NO valida - solo acumula tokens válidos
  // La normalización, evaluación y validación se hace en el webhook cuando hay silencio
  // 
  // shouldEvaluate solo se usa para logging/debugging, NO para evaluación real
  // La evaluación real se hace en el webhook cuando el dominio consolida y envía
  let evaluation = null;
  
  // 🚫 DESACTIVADO: No normalizar, no evaluar internamente - el webhook lo hace
  // Solo retornar estado básico de acumulación
  evaluation = {
    state: IdentityState.INCOMPLETO,
    normalized: null, // 🎯 NO normalizar aquí - el webhook lo hace
    confidence: 0,
    reason: shouldEvaluate ? 'awaiting_webhook_validation' : 'delta_accumulation_only'
  };
  
  if (!shouldEvaluate) {
    log("debug", `📝 [IDENTITY CAPTURE] Delta acumulado (sin normalizar ni evaluar): tokens=${tokens.length} - El webhook validará cuando haya silencio`);
  } else {
    log("debug", `📦 [IDENTITY CAPTURE] Buffer acumulado (sin normalizar ni evaluar): tokens=${tokens.length} - El webhook validará cuando haya silencio`);
  }
  
  return {
    state: evaluation.state,
    normalized: evaluation.normalized,
    confidence: evaluation.confidence,
    tokens,
    reason: evaluation.reason,
    evaluation: evaluation,
    partial: fullText
  };
}

/**
 * 🎯 COMMIT FINAL (con SETNX para evitar doble commit)
 * Guarda la identidad como final cuando el evaluador determina que está completa
 * 
 * @param {string} sessionId - ID de sesión
 * @param {string} normalized - Identidad normalizada
 * @param {string} type - Tipo de identidad
 * @param {number} confidence - Score de confianza
 * @returns {Promise<boolean>} true si se hizo commit, false si ya estaba commitado
 */
/**
 * 🎯 COMMIT FINAL (con SETNX para evitar doble commit)
 * Guarda la identidad como final cuando el evaluador determina que está completa
 * 
 * @param {string} sessionId - ID de sesión
 * @param {string} normalized - Identidad normalizada
 * @param {string} type - Tipo de identidad
 * @param {number} confidence - Score de confianza
 * @returns {Promise<boolean>} true si se hizo commit, false si ya estaba commitado
 */
export async function commitIdentityFinal(sessionId, normalized, type, confidence) {
  if (!sessionId || !normalized) return false;
  
  const lockKey = `id:${type}:locked:${sessionId}`;
  const valueKey = `id:${type}:value:${sessionId}`;
  const identifierKey = `session:identifier:${sessionId}`;
  
  try {
    // 🎯 SETNX: Solo hacer commit si no está bloqueado
    // En redis v5, usar set con opciones NX
    const lockAcquired = await redis.set(lockKey, '1', { EX: 3600, NX: true });
    
    if (!lockAcquired) {
      log("debug", `🔒 [IDENTITY CAPTURE] Commit bloqueado (ya commitado): sessionId=${sessionId}, type=${type}`);
      return false;
    }
    
    // Commit exitoso
    await redis.set(valueKey, normalized, { EX: 3600 });
    await redis.set(identifierKey, normalized, { EX: 3600 });
    
    log("info", `🎯 [RUT_COMMIT] linkedId=${sessionId} rut=${normalized} confidence=${confidence} type=${type}`);
    
    return true;
  } catch (err) {
    log("error", `❌ [IDENTITY CAPTURE] Error en commit final: ${err.message}`);
    return false;
  }
}

/**
 * Obtiene el estado actual de identidad desde Redis
 */
export async function getIdentityState(sessionId, type = 'RUT') {
  if (!sessionId) {
    return {
      state: IdentityState.INCOMPLETO,
      normalized: null,
      confidence: 0,
      tokens: []
    };
  }
  
  const tokensKey = `id:${type}:tokens:${sessionId}`;
  const normalizedKey = `id:${type}:normalized:${sessionId}`;
  const stateKey = `id:${type}:state:${sessionId}`;
  const confidenceKey = `id:${type}:confidence:${sessionId}`;
  const partialKey = `id:${type}:partial:${sessionId}`;
  
  const tokens = await redis.lRange(tokensKey, 0, -1) || [];
  const normalized = await redis.get(normalizedKey) || null;
  const state = await redis.get(stateKey) || IdentityState.INCOMPLETO;
  const confidence = parseInt(await redis.get(confidenceKey) || '0', 10);
  const partial = await redis.get(partialKey) || null;
  
  return {
    state,
    normalized,
    confidence,
    tokens,
    partial: partial || null
  };
}

/**
 * Limpia el buffer de identidad
 * 🎯 MEJORA 2: NO limpiar si la identidad está congelada (VALIDADO)
 */
export async function clearIdentityBuffer(sessionId, type = 'RUT') {
  if (!sessionId) return;
  
  // 🎯 MEJORA 2: Verificar si la identidad está congelada (VALIDADO)
  const frozenKey = `id:${type}:frozen:${sessionId}`;
  const isFrozen = await redis.get(frozenKey);
  if (isFrozen) {
    log("debug", `🔒 [IDENTITY CAPTURE] No se limpia buffer: identidad congelada (VALIDADO) para sessionId=${sessionId}, type=${type}`);
    return; // NO limpiar si está congelada
  }
  
  const tokensKey = `id:${type}:tokens:${sessionId}`;
  const normalizedKey = `id:${type}:normalized:${sessionId}`;
  const stateKey = `id:${type}:state:${sessionId}`;
  const confidenceKey = `id:${type}:confidence:${sessionId}`;
  const partialKey = `id:${type}:partial:${sessionId}`;
  
  await redis.del(tokensKey);
  await redis.del(normalizedKey);
  await redis.del(stateKey);
  await redis.del(confidenceKey);
  await redis.del(partialKey);
  
  log("debug", `🧹 [IDENTITY CAPTURE] Cleared identity buffer for ${sessionId} (type=${type})`);
}

/**
 * Consolida una identidad confirmada (guarda como final)
 */
export async function consolidateIdentity(sessionId, normalized, type = 'RUT') {
  if (!sessionId || !normalized) return false;
  
  try {
    const valueKey = `id:${type}:value:${sessionId}`;
    const identifierKey = `session:identifier:${sessionId}`;
    
    await redis.set(valueKey, normalized, { EX: 3600 });
    await redis.set(identifierKey, normalized, { EX: 3600 });
    
    log("info", `🎯 [IDENTITY CAPTURE] Identity consolidada: ${normalized} (sessionId=${sessionId}, type=${type})`);
    return true;
  } catch (err) {
    log("error", `❌ [IDENTITY CAPTURE] Error consolidando identidad: ${err.message}`);
    return false;
  }
}

/**
 * Valida si una identidad normalizada es válida según el tipo
 */
export function isValidIdentity(normalized, type = 'RUT') {
  if (!normalized || typeof normalized !== 'string') return false;
  
  const config = IDENTITY_CONFIG[type];
  if (!config) return false;
  
  const clean = normalized.replace(/[^0-9kK]/g, '');
  
  if (clean.length < config.minLen || clean.length > config.maxLen) {
    return false;
  }
  
  if (config.dv) {
    // Para RUT, validar DV
    const dvValidation = validateRutDv(clean);
    return dvValidation.valid;
  }
  
  // Para otros tipos, solo validar longitud
  return true;
}
