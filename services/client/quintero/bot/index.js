/**
 * 🤖 Bot Quintero - Entry Point
 * Bot de identificación por RUT para Consultorio Médico de Quintero
 */

import { log } from '../../../../lib/logger.js';
import { initialState, runState } from './state-machine.js';
import * as tts from './tts/messages.js';

/**
 * Inicializa y ejecuta el bot Quintero
 * @param {object} ctx - Contexto de la sesión
 * @returns {Promise<object>} - Resultado de la ejecución
 */
export default async function quinteroBot(ctx) {
  // Inicializar estado si no existe
  if (!ctx.state) {
    ctx.state = initialState();
    ctx.state = initialState();
    log("info", "🆕 [QUINTERO] Estado inicializado");
  }

  // 🛡️ MIGRACIÓN A DOMAIN-DRIVEN PROMPTS (OPCIÓN A)
  // Si es el inicio de la llamada (aún no hay input), el bot DEBE devolver el saludo inicial explícito.
  // Esto evita que el engine busque un archivo de prompt en legacy.
  if (ctx.state.rutPhase === 'WAIT_BODY' && !ctx.transcript) {
    log("info", "🗣️ [QUINTERO] Retornando saludo inicial desde dominio (Bypass Legacy Prompt)");
    return {
      ttsText: getGreeting(),
      nextPhase: 'WAIT_BODY',
      state: ctx.state,
      shouldHangup: false
    };
  }

  // Ejecutar state machine
  const result = await runState(ctx, ctx.state);

  // Retornar resultado con estado actualizado
  return {
    ...result,
    state: ctx.state
  };
}

/**
 * Obtiene el mensaje inicial del bot
 */
export function getGreeting() {
  return tts.askRut();
}
