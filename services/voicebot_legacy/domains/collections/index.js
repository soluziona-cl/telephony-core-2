/**
 * 💳 Dominio Collections
 * Maneja cobranza, compromisos y pagos
 */

import { log } from '../../../../lib/logger.js';
import defaultBot from './default/index.js';

/**
 * Router del dominio Collections
 * @param {object} ctx - Contexto de la sesión
 * @returns {Promise<object>} - Resultado del bot
 */
export default async function collectionsDomain(ctx) {
  const { botName } = ctx;

  log("debug", `💳 [COLLECTIONS] Bot solicitado: ${botName}`);

  // Por ahora, solo tenemos el bot por defecto
  return await defaultBot(ctx);
}

