/**
 * 🔀 Router de Dominios
 * Enruta llamadas a los dominios correspondientes según el modo
 */

import { log } from '../../../lib/logger.js';

// Lazy imports de dominios (solo se cargan cuando se necesitan)
let identityDomain, serviceDomain, salesDomain, collectionsDomain;

/**
 * Resuelve el dominio y bot específico según el modo
 * @param {string} mode - Modo de la llamada (ej: "voicebot_identity_quintero")
 * @returns {Promise<object|null>} - Dominio resuelto o null si no se encuentra
 */
export async function resolveDomain(mode) {
  // Cargar dominios de forma lazy solo cuando se necesitan
  if (!identityDomain) {
    identityDomain = (await import('../domains/identity/index.js')).default;
    serviceDomain = (await import('../domains/service/index.js')).default;
    salesDomain = (await import('../domains/sales/index.js')).default;
    collectionsDomain = (await import('../domains/collections/index.js')).default;
  }
  if (!mode) {
    log("warn", "⚠️ [ROUTER] Modo no especificado, usando service por defecto");
    return serviceDomain;
  }

  // Extraer dominio y bot del modo
  // Formatos soportados:
  // - voicebot_{domain}_{bot} → voicebot_identity_quintero
  // - voicebot_quintero → asume domain: identity, bot: quintero (legacy)
  // - voicebot_quintero_query → asume domain: identity, bot: quintero (legacy)

  const parts = mode.split('_');

  if (parts.length < 2) {
    log("warn", `⚠️ [ROUTER] Formato de modo inválido: "${mode}", usando service por defecto`);
    return serviceDomain;
  }

  // Manejar modos legacy: voicebot_quintero, voicebot_quintero_query
  if (parts.length === 2 && parts[1] === 'quintero') {
    // voicebot_quintero → identity/quintero
    return identityDomain;
  }

  if (parts.length === 3 && parts[1] === 'quintero' && parts[2] === 'query') {
    // voicebot_quintero_query → identity/quintero
    return identityDomain;
  }

  const domainName = parts[1]; // identity, service, sales, collections
  const botName = parts[2] || 'default'; // quintero, ventas, soporte, etc.

  log("debug", `🔀 [ROUTER] Resolviendo: mode="${mode}" → domain="${domainName}", bot="${botName}"`);

  // 🛡️ SHADOW ROUTING CHECK (MIGRATION PHASE 5)
  // Permite desviar a la nueva cápsula aislada si el flag de entorno está activo
  const ROUTING_MODE = process.env.CLIENT_ROUTING_MODE || 'legacy';

  if ((botName === 'quintero' || botName === 'tomadatos' || domainName === 'upcom') && ROUTING_MODE === 'client') {
    log("info", `🚀 [ROUTER] Routing to CAPSULE: ${botName === 'quintero' ? 'Quintero' : 'Upcom'}`);
    try {
      if (botName === 'quintero') {
        return (await import('../../client/quintero/inbound/engine-adapter.js')).default;
      } else {
        return (await import('../../client/upcom.tomadatos/inbound/engine-adapter.js')).default;
      }
    } catch (err) {
      log("error", `❌ [ROUTER] Error cargando cápsula ${botName}, fallback a legacy`, err);
    }
  }

  switch (domainName) {
    case 'identity':
      return identityDomain;

    case 'service':
      return serviceDomain;

    case 'sales':
      return salesDomain;

    case 'collections':
      return collectionsDomain;

    default:
      log("warn", `⚠️ [ROUTER] Dominio desconocido: "${domainName}", usando service por defecto`);
      return serviceDomain;
  }
}

/**
 * Extrae el nombre del bot desde el modo
 * @param {string} mode - Modo de la llamada
 * @returns {string} - Nombre del bot
 */
export function extractBotName(mode) {
  if (!mode) return 'default';

  const parts = mode.split('_');

  // Manejar modos legacy: voicebot_quintero, voicebot_quintero_query
  if (parts.length === 2 && parts[1] === 'quintero') {
    return 'quintero';
  }

  if (parts.length === 3 && parts[1] === 'quintero' && parts[2] === 'query') {
    return 'quintero';
  }

  return parts[2] || 'default';
}

export default {
  resolveDomain,
  extractBotName
};

