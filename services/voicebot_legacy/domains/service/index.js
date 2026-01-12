/**
 * 🛎️ Dominio Service
 * Maneja atención general, información, derivación y soporte
 */

import { log } from '../../../../lib/logger.js';
import defaultBot from './default/index.js';

/**
 * Router del dominio Service
 * @param {object} ctx - Contexto de la sesión
 * @returns {Promise<object>} - Resultado del bot
 */
export default async function serviceDomain(ctx) {
  const { botName } = ctx;

  log("debug", `🛎️ [SERVICE] Bot solicitado: ${botName}`);

  // Por ahora, solo tenemos el bot por defecto
  return await defaultBot(ctx);
}

