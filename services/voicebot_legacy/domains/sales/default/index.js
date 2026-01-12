/**
 * 🤖 Bot Sales Default
 * Bot por defecto para el dominio de ventas
 */

import { log } from '../../../../../lib/logger.js';

/**
 * Bot por defecto de ventas
 * @param {object} ctx - Contexto de la sesión
 * @returns {Promise<object>} - Resultado del bot
 */
export default async function defaultSalesBot(ctx) {
  log("info", "💰 [SALES DEFAULT] Bot por defecto ejecutado");
  
  // Por ahora, solo retorna un mensaje genérico
  // En el futuro, puede implementar lógica básica de ventas
  return {
    ttsText: "Bienvenido. ¿Cómo puedo ayudarle con su consulta?",
    nextPhase: null,
    shouldHangup: false,
    state: ctx.state || {}
  };
}

