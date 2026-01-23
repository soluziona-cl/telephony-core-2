/**
 * 🤖 Bot Quintero - Entry Point
 * Bot de identificación por RUT para Consultorio Médico de Quintero
 */
import { rutDomain } from '../../../domains/rut/index.js';
import { waitRutPhase } from './phases/WAIT_RUT.js';
import { log } from '../../../../lib/logger.js';
import { initialState, runState } from './state-machine.js';
import * as tts from './tts/messages.js';
import { domainTrace } from './utils/domainTrace.js';

// 🆕 PHASED STRATEGY IMPORTS
import phraseConfig from '../config/phases.json' with { type: "json" };
import QuinteroPhasedCapsule from './capsules/phased-capsule.js';

/**
 * Inicializa y ejecuta el bot Quintero
 * @param {object} ctx - Contexto de la sesión
 * @returns {Promise<object>} - Resultado de la ejecución
 */
export default async function quinteroBot(ctx) {
  // 🆕 PHASED STRATEGY CHECK
  // Check if we are in a forced phase (1, 2, 3)
  const currentPhase = phraseConfig.current_phase;

  // Only intercept if phase is 1, 2 or 3 AND we are starting or in a phased state
  // We assume normal operation is phase > 3 or similar, but for now we intercept ALL if configured.
  if ([1, 2, 3].includes(currentPhase)) {
    const phaseNote = (currentPhase >= 3 && (ctx?.event === 'INIT' || ctx?.eventType === 'INIT'))
      ? ' (deferred on INIT)'
      : '';
    log('info', `💊 [QUINTERO] Running in Restricted Phase: ${currentPhase}${phaseNote}`);
    ctx.state = ctx.state ? { ...ctx.state, isPhased: true, phasedEnabled: true } : { isPhased: true, phasedEnabled: true };
    domainTrace(log, {
      file: 'services/client/quintero/bot/index.js',
      fn: 'quinteroBot',
      dispatch: 'phased-capsule',
      event: ctx?.eventType || ctx?.event || 'UNKNOWN',
      phaseIn: ctx.state?.rutPhase,
      phaseOut: ctx.state?.rutPhase,
      action: 'DISPATCH',
      silent: ctx.state?.silent,
      skipInput: ctx.state?.skipInput,
      audio: ctx.state?.audio,
      tts: ctx.state?.ttsText,
      nextPhase: ctx.state?.rutPhase,
      mode: 'PHASED'
    });
    const capsule = new QuinteroPhasedCapsule(currentPhase);
    return await capsule.process(ctx);
  }

  // 🔽 LEGACY / FULL BOT LOGIC BELOW 🔽

  // Inicializar estado si no existe o si rutPhase es 'NONE' (engine default)
  if (!ctx.state || !ctx.state.rutPhase || ctx.state.rutPhase === 'NONE') {
    const newState = initialState();
    ctx.state = ctx.state ? { ...ctx.state, ...newState } : newState;
    log("info", "🆕 [QUINTERO] Estado inicializado");
  }

  // 🔌 TRANSCRIPTION LAYER (Handled by Engine V3)

  // 🆕 BATCH STT: WAIT_RUT Client Phase
  if (ctx.state.rutPhase === 'WAIT_RUT') {
    const waitResult = await waitRutPhase(ctx);
    // Merge state
    if (waitResult.statePatch) {
      ctx.state = { ...ctx.state, ...waitResult.statePatch };
    }
    if (waitResult.nextPhase) {
      ctx.state.rutPhase = waitResult.nextPhase;
    }
    return { ...waitResult, state: ctx.state };
  }

  // 🧠 RUT DOMAIN DELEGATION
  // If we are in a RUT phase, delegate to the generic RUT domain
  // REMOVED 'WAIT_RUT' logic from here to use local phase
  const isPhased = Boolean(ctx?.state?.isPhased === true || ctx?.state?.phasedEnabled === true);
  domainTrace(log, {
    file: 'services/client/quintero/bot/index.js',
    fn: 'dispatch',
    event: ctx?.eventType || ctx?.event || 'UNKNOWN',
    phaseIn: ctx?.state?.rutPhase,
    phaseOut: ctx?.state?.rutPhase,
    action: 'DISPATCH',
    silent: ctx?.state?.silent,
    skipInput: ctx?.state?.skipInput,
    audio: ctx?.state?.audio,
    tts: ctx?.state?.ttsText,
    nextPhase: ctx?.state?.rutPhase,
    mode: isPhased ? 'PHASED' : 'LEGACY'
  });

  if (!isPhased && ['INIT', 'WAIT_BODY', 'WAIT_DV', 'CONFIRM', 'ERROR', 'HANDLE_FORMAT_RUT', 'HANDLE_VALIDATE_PATIENT', 'LISTEN_RUT', 'PROCESS_RUT'].includes(ctx.state.rutPhase)) {
    domainTrace(log, {
      file: 'services/client/quintero/bot/index.js',
      fn: 'rutDomain',
      event: ctx?.eventType || ctx?.event || 'UNKNOWN',
      phaseIn: ctx?.state?.rutPhase,
      phaseOut: 'rut.domain.js',
      action: 'CALL_RUT_DOMAIN',
      silent: ctx?.state?.silent,
      skipInput: ctx?.state?.skipInput,
      audio: ctx?.state?.audio,
      tts: ctx?.state?.ttsText,
      nextPhase: ctx?.state?.rutPhase
    });
    const rutResult = await rutDomain(ctx);

    // Merge state updates
    if (rutResult.action === 'SET_STATE' && rutResult.action.payload && rutResult.action.payload.updates) {
      ctx.state = { ...ctx.state, ...rutResult.action.payload.updates };
    }

    // ✅ CRITICAL FIX: Ensure transition is persisted in state if returned by domain
    if (rutResult.nextPhase) {
      ctx.state.rutPhase = rutResult.nextPhase;
    }

    return { ...rutResult, state: ctx.state };
  }

  // Ejecutar state machine (Resto de Quintero)
  const result = await runState(ctx, ctx.state);

  domainTrace(log, {
    file: 'services/client/quintero/bot/index.js',
    fn: 'quinteroBot',
    event: ctx?.eventType || ctx?.event || 'UNKNOWN',
    phaseIn: ctx.state?.rutPhase,
    phaseOut: ctx.state?.rutPhase,
    action: 'DISPATCH_STATE_MACHINE',
    silent: ctx?.state?.silent,
    skipInput: ctx?.state?.skipInput,
    audio: ctx?.state?.audio,
    tts: ctx?.state?.ttsText,
    nextPhase: ctx?.state?.rutPhase
  });
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
