/**
 * 🎯 INCREMENTAL RUT PROCESSOR
 * Wrapper alrededor de identity-capture.js para compatibilidad hacia atrás
 * 
 * Este módulo mantiene la API existente pero delega en identity-capture.js
 * que es genérico y reutilizable para RUT, DNI, Nº deuda, etc.
 */

import { log } from "../../../lib/logger.js";
import redis from "../../../lib/redis.js";
import {
  processIdentityDelta,
  getIdentityState,
  clearIdentityBuffer,
  consolidateIdentity,
  isValidIdentity,
  IdentityState
} from "./identity-capture.js";

/**
 * Guarda transcripción parcial en Redis usando LIST (RPUSH) - modelo push incremental
 * 
 * 🎯 DELEGADO A: identity-capture.js (módulo genérico)
 * Mantiene compatibilidad hacia atrás con la API existente
 * 
 * @param {string} sessionId - ID de sesión
 * @param {string} partialText - Texto parcial (delta o texto completo)
 * @param {boolean} isDelta - Si true, es un delta que se debe push. Si false, reemplaza todo
 */
export async function savePartialRut(sessionId, partialText, isDelta = false) {
  if (!sessionId || !partialText) return;

  if (isDelta) {
    // 🎯 DELEGAR: Usar módulo genérico para procesar delta
    // 🎯 FIX CRÍTICO: NO evaluar en deltas incrementales (shouldEvaluate=false)
    // Solo acumular tokens, la evaluación se hará cuando la transcripción esté completa
    const result = await processIdentityDelta(sessionId, partialText, 'RUT', false);
    
    // Mantener compatibilidad: actualizar keys legacy (rut:partial, rut:digits)
    // para código que aún las lee directamente
    const partialKey = `rut:partial:${sessionId}`;
    const digitsKey = `rut:digits:${sessionId}`;
    
    if (result.partial) {
      await redis.set(partialKey, result.partial, { EX: 60 });
    }
    if (result.normalized) {
      await redis.set(digitsKey, result.normalized, { EX: 60 });
    }
    
    return partialText.trim();
  } else {
    // 🎯 FIX CRÍTICO: Cuando isDelta=false, es transcripción completa
    // Usar el texto completo como fuente única, NO procesar tokens individuales
    // Esto evita duplicación con tokens ya pusheados durante deltas
    await clearPartialRut(sessionId);
    
    // 🎯 ARQUITECTURA CORRECTA: Guardar texto completo directamente
    // El texto completo es la fuente de verdad, no los tokens individuales
    const trimmedText = partialText.trim();
    const partialKey = `id:RUT:partial:${sessionId}`;
    const tokensKey = `id:RUT:tokens:${sessionId}`;
    
    // Guardar texto completo como partial (fuente única)
    await redis.set(partialKey, trimmedText, { EX: 60 });
    
    // 🎯 CRÍTICO: NO dividir en tokens ni procesar individualmente
    // El texto completo ya está consolidado por OpenAI, usarlo directamente
    // Los tokens solo se usan para deltas incrementales, no para transcripciones completas
    log("debug", `📦 [INCREMENTAL RUT] Transcripción completa guardada: "${trimmedText}" - Usando como fuente única (sin procesar tokens)`);
    
    // Actualizar keys legacy para compatibilidad
    const legacyPartialKey = `rut:partial:${sessionId}`;
    await redis.set(legacyPartialKey, trimmedText, { EX: 60 });
    
    return trimmedText;
  }
}

/**
 * Obtiene el RUT parcial acumulado desde Redis (texto RAW ensamblado)
 * 
 * 🎯 DELEGADO A: identity-capture.js
 */
export async function getPartialRut(sessionId) {
  if (!sessionId) return '';
  
  const state = await getIdentityState(sessionId, 'RUT');
  return state.partial || '';
}

/**
 * Reconstruye palabras fragmentadas del STT
 * Ejemplo: "ator ce" → "catorce", "tres ientos" → "trescientos"
 * 
 * 🎯 IMPORTANTE: Esta función debe ejecutarse ANTES de quitar espacios
 * para que los fragmentos se unan correctamente en palabras completas
 */
function reconstructFragmentedWords(text) {
  if (!text || typeof text !== 'string') return text;
  
  // Normalizar espacios múltiples primero
  let reconstructed = text.replace(/\s+/g, ' ').trim();
  
  // Patrones de fragmentación comunes del STT (ordenados por especificidad)
  const fragmentPatterns = [
    // Fragmentos de "catorce" (múltiples variantes)
    { pattern: /\bator\s+ce\b/gi, replacement: 'catorce' },
    { pattern: /\bcat\s+or\s+ce\b/gi, replacement: 'catorce' },
    { pattern: /\bca\s+torce\b/gi, replacement: 'catorce' },
    
    // Fragmentos de centenas (CRÍTICO: ordenar de más específico a menos)
    { pattern: /\btres\s+ientos\b/gi, replacement: 'trescientos' },
    { pattern: /\bdos\s+ientos\b/gi, replacement: 'doscientos' },
    { pattern: /\bcuatro\s+cientos\b/gi, replacement: 'cuatrocientos' },
    { pattern: /\bcu\s+atro\s+ientos\b/gi, replacement: 'cuatrocientos' },
    { pattern: /\bcuar\s+ientos\b/gi, replacement: 'cuatrocientos' },
    { pattern: /\bcinco\s+ientos\b/gi, replacement: 'quinientos' },
    { pattern: /\bquin\s+ientos\b/gi, replacement: 'quinientos' },
    { pattern: /\bseis\s+ientos\b/gi, replacement: 'seiscientos' },
    { pattern: /\bsiete\s+ientos\b/gi, replacement: 'setecientos' },
    { pattern: /\bsete\s+cientos\b/gi, replacement: 'setecientos' },
    { pattern: /\bocho\s+ientos\b/gi, replacement: 'ochocientos' },
    { pattern: /\bnueve\s+ientos\b/gi, replacement: 'novecientos' },
    { pattern: /\bnove\s+cientos\b/gi, replacement: 'novecientos' },
    
    // Fragmentos de decenas (CRÍTICO: ordenar de más específico a menos)
    { pattern: /\bcuar\s+enta\b/gi, replacement: 'cuarenta' },
    { pattern: /\bcu\s+arenta\b/gi, replacement: 'cuarenta' },
    { pattern: /\bcinc\s+uenta\b/gi, replacement: 'cincuenta' },
    { pattern: /\bcinc\s+enta\b/gi, replacement: 'cincuenta' },
    { pattern: /\bseis\s+enta\b/gi, replacement: 'sesenta' },
    { pattern: /\bsiete\s+enta\b/gi, replacement: 'setenta' },
    { pattern: /\bocho\s+enta\b/gi, replacement: 'ochenta' },
    { pattern: /\bnueve\s+enta\b/gi, replacement: 'noventa' },
    
    // Fragmentos de "cuatro"
    { pattern: /\bcu\s+atro\b/gi, replacement: 'cuatro' },
    
    // Fragmentos de "millones"
    { pattern: /\bmil\s+lones\b/gi, replacement: 'millones' },
    { pattern: /\bmil\s+ones\b/gi, replacement: 'millones' },
    
    // Fragmentos de "veinticinco", "veintitrés", etc.
    { pattern: /\bveinti\s+tres\b/gi, replacement: 'veintitrés' },
    { pattern: /\bveinti\s+cinco\b/gi, replacement: 'veinticinco' },
    { pattern: /\bveinti\s+seis\b/gi, replacement: 'veintiséis' },
    { pattern: /\bveinti\s+siete\b/gi, replacement: 'veintisiete' },
    { pattern: /\bveinti\s+ocho\b/gi, replacement: 'veintiocho' },
    { pattern: /\bveinti\s+nueve\b/gi, replacement: 'veintinueve' },
    
    // Fragmentos de "dieciséis", "diecisiete", etc.
    { pattern: /\bdieci\s+seis\b/gi, replacement: 'dieciséis' },
    { pattern: /\bdieci\s+siete\b/gi, replacement: 'diecisiete' },
    { pattern: /\bdieci\s+ocho\b/gi, replacement: 'dieciocho' },
    { pattern: /\bdieci\s+nueve\b/gi, replacement: 'diecinueve' },
  ];
  
  // Aplicar reconstrucción (múltiples pasadas para casos anidados)
  for (let i = 0; i < 3; i++) {
    let changed = false;
    for (const { pattern, replacement } of fragmentPatterns) {
      const before = reconstructed;
      reconstructed = reconstructed.replace(pattern, replacement);
      if (before !== reconstructed) {
        changed = true;
      }
    }
    if (!changed) break; // No hay más cambios, salir
  }
  
  // Normalizar espacios múltiples después de reconstrucción
  reconstructed = reconstructed.replace(/\s+/g, ' ').trim();
  
  return reconstructed;
}

/**
 * Obtiene el RUT consolidado SIN espacios para enviar al webhook
 * 
 * 🎯 ARQUITECTURA: Reconstruye palabras fragmentadas y luego une sin espacios:
 * "ator ce millones" → "catorce millones" → "catorcemillones"
 * 
 * @param {string} sessionId - ID de sesión
 * @returns {Promise<string>} Texto consolidado sin espacios
 */
export async function getConsolidatedRutText(sessionId) {
  if (!sessionId) return '';
  
  // 🕒 AUDITORÍA: Inicio de consolidación
  const tConsolidateStart = Date.now();
  
  try {
    // 🎯 PRIORIDAD: Usar partial (tiene el texto completo con espacios)
    // Es más confiable que unir tokens directamente porque ya tiene el contexto
    const tStateStart = Date.now();
    const state = await getIdentityState(sessionId, 'RUT');
    const tStateEnd = Date.now();
    const stateReadTime = tStateEnd - tStateStart;
    
    let textWithSpaces = state.partial || '';
    
    // Si no hay partial, construir desde tokens
    if (!textWithSpaces || textWithSpaces.trim().length === 0) {
      const tTokensStart = Date.now();
      const tokensKey = `id:RUT:tokens:${sessionId}`;
      const tokens = await redis.lRange(tokensKey, 0, -1) || [];
      const tTokensEnd = Date.now();
      const tokensReadTime = tTokensEnd - tTokensStart;
      
      if (tokens.length > 0) {
        textWithSpaces = tokens.join(' ');
        log("debug", `📦 [INCREMENTAL RUT] Construido desde tokens (${tokens.length} tokens, ${tokensReadTime}ms)`);
      }
    }
    
    if (!textWithSpaces || textWithSpaces.trim().length === 0) {
      log("warn", `⚠️ [INCREMENTAL RUT] No hay texto para consolidar (sessionId=${sessionId})`);
      return '';
    }
    
    // 🎯 RECONSTRUIR: Primero reconstruir palabras fragmentadas
    const tReconstructStart = Date.now();
    const reconstructed = reconstructFragmentedWords(textWithSpaces);
    const tReconstructEnd = Date.now();
    const reconstructTime = tReconstructEnd - tReconstructStart;
    
    // 🎯 CONSOLIDAR: Luego quitar espacios
    const consolidated = reconstructed.replace(/\s+/g, '');
    
    // 🕒 AUDITORÍA: Tiempo total de consolidación
    const tConsolidateEnd = Date.now();
    const consolidateTime = tConsolidateEnd - tConsolidateStart;
    
    log("debug", `📦 [INCREMENTAL RUT] Texto consolidado: "${consolidated}" (original="${textWithSpaces}", tokens=${state.tokens?.length || 0})`, {
      stateReadTime: `${stateReadTime}ms`,
      reconstructTime: `${reconstructTime}ms`,
      consolidateTime: `${consolidateTime}ms`,
      status: consolidateTime <= 30 ? 'IDEAL' : consolidateTime <= 100 ? 'ACEPTABLE' : 'LENTO'
    });
    return consolidated;
  } catch (err) {
    // 🕒 AUDITORÍA: Tiempo hasta error
    const tError = Date.now();
    const timeToError = tError - tConsolidateStart;
    
    log("error", `❌ [INCREMENTAL RUT] Error consolidando texto: ${err.message}`, {
      timeToError: `${timeToError}ms`
    });
    // Fallback: usar partial sin espacios
    const state = await getIdentityState(sessionId, 'RUT');
    const partial = state.partial || '';
    return partial.replace(/\s+/g, '');
  }
}

/**
 * Obtiene el RUT parcial normalizado desde Redis (solo dígitos)
 * 
 * 🎯 DELEGADO A: identity-capture.js
 */
export async function getNormalizedPartialRut(sessionId) {
  if (!sessionId) return '';
  
  const state = await getIdentityState(sessionId, 'RUT');
  return state.normalized || '';
}

/**
 * Limpia el buffer de RUT parcial (LIST, cache y dígitos)
 * 
 * 🎯 DELEGADO A: identity-capture.js
 * También limpia keys legacy para compatibilidad
 * 
 * 🎯 FIX C: NO borrar id:RUT:* mientras estás capturando (verificar enteredListenTs)
 * 
 * 🎯 MEJORA: Limpiar también el flag de webhook enviado
 */
export async function clearPartialRut(sessionId) {
  if (!sessionId) return;

  // 🎯 FIX C: Verificar si ya estás en modo escucha antes de borrar
  const enteredListenTsKey = `voicebot:quintero:${sessionId}:rut:enteredListenTs`;
  const enteredListenTs = await redis.get(enteredListenTsKey);
  
  if (enteredListenTs && parseInt(enteredListenTs, 10) > 0) {
    // Ya estás en modo escucha, NO borrar id:RUT:*
    log("debug", `🔒 [INCREMENTAL RUT] NO borrando id:RUT:* para ${sessionId} (enteredListenTs=${enteredListenTs}, ya en modo escucha)`);
    // Solo limpiar keys legacy si es necesario
    return;
  }

  // Limpiar usando módulo genérico (solo si no estás en modo escucha)
  await clearIdentityBuffer(sessionId, 'RUT');
  
  // 🎯 MEJORA: Limpiar también el flag de webhook enviado
  await redis.del(`rut:webhook:sent:${sessionId}`);
  
  // Limpiar keys legacy (compatibilidad)
  const legacyKeys = [
    `rut:tokens:${sessionId}`,
    `rut:digits:${sessionId}`,
    `rut:partial:${sessionId}`,
    `rut:partial:normalized:${sessionId}`
  ];
  
  for (const key of legacyKeys) {
    await redis.del(key);
  }
  
  log("debug", `🧹 [INCREMENTAL RUT] Cleared partial buffer (LIST + cache + digits + webhook flag) for ${sessionId}`);
}

/**
 * Valida si un RUT parcial es válido (longitud mínima)
 * 
 * 🎯 DELEGADO A: identity-capture.js
 */
export function isValidPartialRut(normalized) {
  return isValidIdentity(normalized, 'RUT');
}

/**
 * Consolida un RUT válido como RUT final (para uso en FINALIZE)
 * 
 * 🎯 DELEGADO A: identity-capture.js
 */
export async function consolidateRut(sessionId, rutValue) {
  return await consolidateIdentity(sessionId, rutValue, 'RUT');
}

/**
 * Obtiene el estado completo de RUT (incluyendo confidence y state)
 * 
 * 🎯 NUEVO: Permite al dominio tomar decisiones basadas en score de confianza
 */
export async function getRutState(sessionId) {
  if (!sessionId) {
    return {
      state: IdentityState.INCOMPLETO,
      normalized: null,
      confidence: 0,
      tokens: [],
      partial: null
    };
  }
  
  return await getIdentityState(sessionId, 'RUT');
}
