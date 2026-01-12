/**
 * 🤖 Bot Collections Default
 * Bot por defecto para el dominio de cobranza
 */

import { log } from '../../../../../lib/logger.js';

/**
 * Bot por defecto de cobranza
 * @param {object} ctx - Contexto de la sesión
 * @returns {Promise<object>} - Resultado del bot
 */
export default async function defaultCollectionsBot(ctx) {
  log("info", "💳 [COLLECTIONS DEFAULT] Bot por defecto ejecutado");
  
  // Por ahora, solo retorna un mensaje genérico
  // En el futuro, puede implementar lógica básica de cobranza
  return {
    ttsText: "Bienvenido. ¿En qué puedo ayudarle con su consulta?",
    nextPhase: null,
    shouldHangup: false,
    state: ctx.state || {}
  };
}

