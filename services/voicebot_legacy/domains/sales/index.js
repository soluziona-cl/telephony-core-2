/**
 * 💰 Dominio Sales
 * Maneja ventas, captación y campañas
 */

import { log } from '../../../../lib/logger.js';
import defaultBot from './default/index.js';

/**
 * Router del dominio Sales
 * @param {object} ctx - Contexto de la sesión
 * @returns {Promise<object>} - Resultado del bot
 */
export default async function salesDomain(ctx) {
  const { botName } = ctx;

  log("debug", `💰 [SALES] Bot solicitado: ${botName}`);

  // Por ahora, solo tenemos el bot por defecto
  return await defaultBot(ctx);
}

