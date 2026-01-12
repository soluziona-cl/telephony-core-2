/**
 * 🆔 Dominio Identity
 * Maneja identificación y validación de usuarios (RUT, datos personales)
 */

import { log } from '../../../../lib/logger.js';
import quinteroBot from './quintero/index.js';
import defaultBot from './default/index.js';

/**
 * Router del dominio Identity
 * @param {object} ctx - Contexto de la sesión
 * @returns {Promise<object>} - Resultado del bot
 */
export default async function identityDomain(ctx) {
  const { botName } = ctx;

  log("debug", `🆔 [IDENTITY] Bot solicitado: ${botName}`);

  if (botName === 'quintero') {
    return await quinteroBot(ctx);
  }

  // Bot por defecto
  return await defaultBot(ctx);
}

