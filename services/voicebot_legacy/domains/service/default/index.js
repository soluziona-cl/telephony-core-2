/**
 * 🤖 Bot Service Default
 * Bot por defecto para el dominio de servicio
 */

import { log } from '../../../../../lib/logger.js';

/**
 * Bot por defecto de servicio
 * @param {object} ctx - Contexto de la sesión
 * @returns {Promise<object>} - Resultado del bot
 */
export default async function defaultServiceBot(ctx) {
  log("info", "🛎️ [SERVICE DEFAULT] Bot por defecto ejecutado");
  
  // Por ahora, solo retorna un mensaje genérico
  // En el futuro, puede implementar lógica básica de atención
  return {
    ttsText: "¿En qué puedo ayudarle?",
    nextPhase: null,
    shouldHangup: false,
    state: ctx.state || {}
  };
}

