/**
 * 🔗 Cliente HTTP para Webhooks n8n
 * Delega toda la lógica de negocio al webhook
 * Específico del dominio Quintero
 */

import { log } from '../../../../../lib/logger.js';

const WEBHOOK_BASE_URL = process.env.N8N_WEBHOOK_URL || 'http://10.100.112.115/webhook/c35e936f-0b53-4bff-ab67-87c69da641ee';

/**
 * Cliente HTTP simple (sin dependencias externas)
 * n8n retorna respuestas envueltas en { "output": "{...json string...}" }
 */
async function httpRequest(url, method = 'POST', body = null) {
  try {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000) // 10 segundos timeout
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      log('error', `❌ [WEBHOOK] HTTP ${response.status}: ${response.statusText}`);
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const rawData = await response.json();

    // n8n envuelve la respuesta en { "output": "{...json string...}" }
    let data;
    if (rawData.output) {
      try {
        data = JSON.parse(rawData.output);
      } catch (parseErr) {
        log('error', `❌ [WEBHOOK] Error parseando output: ${parseErr.message}`);
        return { ok: false, error: 'Invalid JSON in output' };
      }
    } else {
      // Fallback: si no viene en output, usar directamente
      data = rawData;
    }

    return { ok: true, data };
  } catch (error) {
    log('error', `❌ [WEBHOOK] Error en request: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/**
 * 🎯 EVENTO 1: Formatear RUT desde transcripción
 * @param {string} rutRaw - Transcripción del usuario (ej: "14.348.258, raya 8")
 * @param {string} sessionId - LinkedId de la sesión
 * @param {string} ani - Número de origen
 * @param {string} dnis - Número de destino
 * @returns {Promise<object>} - { ok: boolean, rut: string|null, body: string|null, dv: string|null, reason: string|null }
 */
export async function formatRut(rutRaw, sessionId, ani = null, dnis = null) {
  const payload = {
    action: 'FORMAT_RUT',
    rut_raw: rutRaw || '',
    channel: 'VOICEBOT',
    sessionId: sessionId || '',
    timestamp: new Date().toISOString()
  };

  // Incluir ani y dnis si están disponibles
  if (ani) payload.ani = ani;
  if (dnis) payload.dnis = dnis;

  // 🛡️ GUARDRAIL: No enviar request si el rut_raw está vacío
  if (!rutRaw || !rutRaw.trim()) {
    log('warn', `⚠️ [WEBHOOK] FORMAT_RUT abortado: Input vacío`);
    return { ok: false, rut: null, body: null, dv: null, reason: 'EMPTY_INPUT' };
  }

  log('info', `📤 [WEBHOOK] FORMAT_RUT: "${rutRaw}"`);

  const result = await httpRequest(WEBHOOK_BASE_URL, 'POST', payload);

  if (!result.ok) {
    log('error', `❌ [WEBHOOK] FORMAT_RUT falló: ${result.error}`);
    return { ok: false, rut: null, body: null, dv: null, reason: 'TECHNICAL_ERROR' };
  }

  const { data } = result;

  // Caso NOK: INVALID_RUT_FORMAT
  if (!data.ok && data.reason === 'INVALID_RUT_FORMAT') {
    log('warn', `⚠️ [WEBHOOK] FORMAT_RUT: RUT inválido - ${data.reason}`);
    return { ok: false, rut: null, body: null, dv: null, reason: data.reason };
  }

  if (data.ok && data.rut) {
    log('info', `✅ [WEBHOOK] RUT formateado: ${data.rut} (body=${data.body}, dv=${data.dv})`);
    return {
      ok: true,
      rut: data.rut,
      body: data.body || null,
      dv: data.dv || null,
      reason: null
    };
  }

  log('warn', `⚠️ [WEBHOOK] FORMAT_RUT: ok=${data.ok}, reason=${data.reason || 'unknown'}`);
  return { ok: false, rut: null, body: null, dv: null, reason: data.reason || 'UNKNOWN' };
}

/**
 * 🎯 EVENTO 2: Validar paciente por RUT
 * @param {string} rut - RUT formateado (ej: "14348258-8")
 * @param {string} sessionId - LinkedId de la sesión
 * @returns {Promise<object>} - { ok: boolean, patientFound: boolean, nombre: string|null, edad: number|null, reason: string|null }
 */
export async function validatePatient(rut, sessionId) {
  const payload = {
    action: 'VALIDATE_PATIENT',
    rut: rut || '',
    channel: 'VOICEBOT',
    sessionId: sessionId || '',
    timestamp: new Date().toISOString()
  };

  log('info', `📤 [WEBHOOK] VALIDATE_PATIENT: RUT=${rut}`);

  const result = await httpRequest(WEBHOOK_BASE_URL, 'POST', payload);

  if (!result.ok) {
    log('error', `❌ [WEBHOOK] VALIDATE_PATIENT falló: ${result.error}`);
    return { ok: false, patientFound: false, nombre: null, edad: null, reason: 'TECHNICAL_ERROR' };
  }

  const { data } = result;

  // Casos NOK
  if (!data.ok) {
    const reason = data.reason || 'UNKNOWN';
    log('warn', `⚠️ [WEBHOOK] VALIDATE_PATIENT NOK: ${reason}`);

    if (reason === 'PATIENT_NOT_FOUND' || reason === 'MISSING_REQUIRED_FIELDS') {
      return {
        ok: false,
        patientFound: false,
        nombre: null,
        edad: null,
        reason
      };
    }

    return { ok: false, patientFound: false, nombre: null, edad: null, reason };
  }

  if (data.patientFound) {
    log('info', `✅ [WEBHOOK] Paciente encontrado: ${data.nombre || 'Sin nombre'} (edad: ${data.edad || 'N/A'})`);
    return {
      ok: true,
      patientFound: true,
      nombre: data.nombre || null,
      edad: data.edad || null,
      reason: null
    };
  }

  log('info', `ℹ️ [WEBHOOK] Paciente NO encontrado para RUT: ${rut}`);
  return { ok: true, patientFound: false, nombre: null, edad: null, reason: null };
}

/**
 * 🎯 EVENTO 3: Buscar próxima hora médica disponible
 * @param {string} rut - RUT del paciente
 * @param {string} especialidad - Especialidad solicitada
 * @param {string} sessionId - LinkedId de la sesión
 * @returns {Promise<object>} - { ok: boolean, horaFound: boolean, fecha: string|null, hora: string|null, doctor_box: string|null, especialidad: string|null, hold: boolean, holdUntil: string|null, requisito: string|null, reason: string|null }
 */
/**
 * Cache simple para prefetch: key -> { promise, timestamp }
 */
const prefetchCache = new Map();
const CACHE_TTL_MS = 30000; // 30 segundos

/**
 * 🎯 PREFETCH: Inicia búsqueda en background y guarda promesa
 */
export function prefetchNextAvailability(rut, especialidad, sessionId) {
  const key = `${sessionId}:${rut}:${especialidad}`;
  log('info', `🚀 [WEBHOOK] PREFETCH iniciado para: ${key}`);

  // Llamamos a la implementación directa (sin revisar cache para evitar loop)
  const promise = fetchNextAvailabilityImpl(rut, especialidad, sessionId);

  prefetchCache.set(key, {
    promise,
    timestamp: Date.now()
  });

  // Limpieza automática
  setTimeout(() => {
    if (prefetchCache.has(key)) {
      prefetchCache.delete(key);
      log('debug', `🗑️ [WEBHOOK] Cache expirado para: ${key}`);
    }
  }, CACHE_TTL_MS);
}

/**
 * 🎯 EVENTO 3: Buscar próxima hora médica disponible (con soporte Cache)
 */
export async function getNextAvailability(rut, especialidad, sessionId) {
  const key = `${sessionId}:${rut}:${especialidad}`;

  // 1. Revisar caché (Hit)
  if (prefetchCache.has(key)) {
    const cached = prefetchCache.get(key);
    // Validar frescura (aunque el timeout limpia, doble check es seguro)
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      log('info', `⚡ [WEBHOOK] Cache HIT para: ${key}. Usando resultado pre-cargado.`);
      prefetchCache.delete(key); // Consumir una sola vez (evitar staled)
      return cached.promise;
    }
  }

  // 2. Cache Miss: Buscar directamente
  log('info', `🐌 [WEBHOOK] Cache MISS para: ${key}. Consultando webhook en tiempo real.`);
  return fetchNextAvailabilityImpl(rut, especialidad, sessionId);
}

/**
 * Implementación interna de la búsqueda (la lógica original)
 */
async function fetchNextAvailabilityImpl(rut, especialidad, sessionId) {
  const payload = {
    action: 'GET_NEXT_AVAILABILITY',
    rut: rut || '',
    especialidad: especialidad || '',
    channel: 'VOICEBOT',
    sessionId: sessionId || '',
    timestamp: new Date().toISOString()
  };

  log('info', `📤 [WEBHOOK] GET_NEXT_AVAILABILITY (Impl): RUT=${rut}, Especialidad=${especialidad}`);

  const result = await httpRequest(WEBHOOK_BASE_URL, 'POST', payload);

  if (!result.ok) {
    log('error', `❌ [WEBHOOK] GET_NEXT_AVAILABILITY falló: ${result.error}`);
    return {
      ok: false,
      horaFound: false,
      fecha: null,
      hora: null,
      doctor_box: null,
      especialidad: null,
      hold: false,
      holdUntil: null,
      requisito: null,
      reason: 'TECHNICAL_ERROR'
    };
  }

  const { data } = result;

  // Casos NOK: NO_AVAILABILITY o SPECIALTY_NOT_MAPPED
  if (!data.horaFound) {
    const reason = data.reason || 'NO_AVAILABILITY';
    log('warn', `⚠️ [WEBHOOK] GET_NEXT_AVAILABILITY NOK: ${reason}`);
    return {
      ok: true, // OK técnico, pero sin hora
      horaFound: false,
      fecha: null,
      hora: null,
      doctor_box: null,
      especialidad: data.especialidad || null,
      hold: false,
      holdUntil: null,
      requisito: null,
      reason
    };
  }

  if (data.horaFound) {
    log('info', `✅ [WEBHOOK] Hora encontrada: ${data.fecha} ${data.hora} - ${data.doctor_box || 'Sin doctor'} (hold=${data.hold || false})`);
    return {
      ok: true,
      horaFound: true,
      fecha: data.fecha || null,
      hora: data.hora || null,
      doctor_box: data.doctor_box || null,
      especialidad: data.especialidad || null,
      hold: data.hold || false,
      holdUntil: data.holdUntil || null,
      requisito: data.requisito || null,
      reason: null
    };
  }

  log('info', `ℹ️ [WEBHOOK] No hay horas disponibles para: ${especialidad}`);
  return {
    ok: true,
    horaFound: false,
    fecha: null,
    hora: null,
    doctor_box: null,
    especialidad: null,
    hold: false,
    holdUntil: null,
    requisito: null,
    reason: 'UNKNOWN'
  };
}

/**
 * 🎯 EVENTO 4: Confirmar hora médica reservada
 * @param {string} sessionId - LinkedId de la sesión
 * @returns {Promise<object>} - { ok: boolean, confirmed: boolean, especialidad: string|null, fecha: string|null, hora: string|null, reason: string|null }
 */
export async function confirmAvailability(sessionId) {
  const payload = {
    action: 'CONFIRM_AVAILABILITY',
    channel: 'VOICEBOT',
    sessionId: sessionId || '',
    timestamp: new Date().toISOString()
  };

  log('info', `📤 [WEBHOOK] CONFIRM_AVAILABILITY: sessionId=${sessionId}`);

  const result = await httpRequest(WEBHOOK_BASE_URL, 'POST', payload);

  if (!result.ok) {
    log('error', `❌ [WEBHOOK] CONFIRM_AVAILABILITY falló: ${result.error}`);
    return {
      ok: false,
      confirmed: false,
      especialidad: null,
      fecha: null,
      hora: null,
      reason: 'TECHNICAL_ERROR'
    };
  }

  const { data } = result;

  // Caso NOK: HOLD_NOT_FOUND_OR_EXPIRED
  if (!data.confirmed) {
    const reason = data.reason || 'HOLD_NOT_FOUND_OR_EXPIRED';
    log('warn', `⚠️ [WEBHOOK] CONFIRM_AVAILABILITY NOK: ${reason}`);
    return {
      ok: false,
      confirmed: false,
      especialidad: null,
      fecha: null,
      hora: null,
      reason
    };
  }

  log('info', `✅ [WEBHOOK] Hora confirmada: ${data.especialidad || 'N/A'} - ${data.fecha || 'N/A'} ${data.hora || 'N/A'}`);
  return {
    ok: true,
    confirmed: true,
    especialidad: data.especialidad || null,
    fecha: data.fecha || null,
    hora: data.hora || null,
    reason: null
  };
}

/**
 * 🎯 EVENTO 5: Liberar hora médica reservada (hold)
 * @param {string} sessionId - LinkedId de la sesión
 * @returns {Promise<object>} - { ok: boolean, released: boolean, especialidad: string|null, fecha: string|null, hora: string|null }
 */
export async function releaseAvailability(sessionId) {
  const payload = {
    action: 'RELEASE_AVAILABILITY',
    channel: 'VOICEBOT',
    sessionId: sessionId || '',
    timestamp: new Date().toISOString()
  };

  log('info', `📤 [WEBHOOK] RELEASE_AVAILABILITY: sessionId=${sessionId}`);

  const result = await httpRequest(WEBHOOK_BASE_URL, 'POST', payload);

  if (!result.ok) {
    log('error', `❌ [WEBHOOK] RELEASE_AVAILABILITY falló: ${result.error}`);
    return {
      ok: false,
      released: false,
      especialidad: null,
      fecha: null,
      hora: null
    };
  }

  const { data } = result;

  // released puede ser false sin ser error (no había hold activo)
  if (data.released) {
    log('info', `✅ [WEBHOOK] Hora liberada: ${data.especialidad || 'N/A'} - ${data.fecha || 'N/A'} ${data.hora || 'N/A'}`);
  } else {
    log('info', `ℹ️ [WEBHOOK] No había hold activo para liberar (sessionId=${sessionId})`);
  }

  return {
    ok: true,
    released: data.released || false,
    especialidad: data.especialidad || null,
    fecha: data.fecha || null,
    hora: data.hora || null
  };
}

export default {
  formatRut,
  validatePatient,
  getNextAvailability,
  confirmAvailability,
  releaseAvailability
};

