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
  // Inicializar estado si no existe o si rutPhase es 'NONE' (engine default)
  if (!ctx.state || !ctx.state.rutPhase || ctx.state.rutPhase === 'NONE') {
    const newState = initialState();
    ctx.state = ctx.state ? { ...ctx.state, ...newState } : newState;
    log("info", "🆕 [QUINTERO] Estado inicializado");
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
