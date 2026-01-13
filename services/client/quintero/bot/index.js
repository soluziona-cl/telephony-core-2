/**
 * 🤖 Bot Quintero - Entry Point
 * Bot de identificación por RUT para Consultorio Médico de Quintero
 */
import { rutDomain } from '../../../domains/rut/index.js';

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

  // 🔌 TRANSCRIPTION LAYER (Domain Responsibility)
  // The engine no longer transcribes. We must do it here if needed.
  if ((!ctx.transcript || ctx.transcript.trim() === "") && ctx.audioPath && ctx.openai) {
    try {
      log("info", "🎤 [QUINTERO] Delegating transcription to OpenAI (Strict Mode)...");
      ctx.transcript = await ctx.openai.transcribeAudioOnly(ctx.audioPath);
      log("info", `📝 [QUINTERO] Transcript: "${ctx.transcript}"`);
    } catch (err) {
      log("error", `❌ [QUINTERO] Transcription error: ${err.message}`);
    }
  }

  // 🧠 RUT DOMAIN DELEGATION
  // If we are in a RUT phase, delegate to the generic RUT domain
  if (['INIT', 'WAIT_BODY', 'WAIT_DV', 'CONFIRM', 'ERROR'].includes(ctx.state.rutPhase)) {
    const rutResult = await rutDomain(ctx);
    // Merge state updates
    if (rutResult.action === 'SET_STATE' && rutResult.action.payload && rutResult.action.payload.updates) {
      ctx.state = { ...ctx.state, ...rutResult.action.payload.updates };
    }
    return { ...rutResult, state: ctx.state };
  }

  // Ejecutar state machine (Resto de Quintero)
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
