/**
 * 🤖 Bot Identity Default
 * Bot por defecto para el dominio de identidad
 */

import { log } from '../../../../../lib/logger.js';

/**
 * Bot por defecto de identidad
 * @param {object} ctx - Contexto de la sesión
 * @returns {Promise<object>} - Resultado del bot
 */
export default async function defaultIdentityBot(ctx) {
  log("info", "🆔 [IDENTITY DEFAULT] Bot por defecto ejecutado");
  
  // Por ahora, solo retorna un mensaje genérico
  // En el futuro, puede implementar lógica básica de identificación
  return {
    ttsText: "Por favor, indíqueme sus datos de identificación.",
    nextPhase: null,
    shouldHangup: false,
    state: ctx.state || {}
  };
}

