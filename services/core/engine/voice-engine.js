// =========================================================
// VOICEBOT ENGINE V3 - Ultra-Low Latency con Barge-In Real
// =========================================================
// ✅ Sesión WebSocket persistente (sin reconexión por turno)
// ✅ Barge-in real con cancelación de respuesta OpenAI
// ✅ Detección de silencio agresiva (1.5s vs 4s)
// ✅ Timeouts más cortos
// ✅ VAD (Voice Activity Detection) mejorado
// =========================================================


import { exec } from "child_process";
import { promisify } from "util";
import { OpenAIRealtimeClientV3 } from "./openai-client.js";
import { log } from "../../../lib/logger.js";
import { startRecording, stopRecording } from "../telephony/telephony-recorder.js";
import { inboundConfig as config } from "./config.js";
import { buildPrompt } from "./legacy-compat/prompt-builder.js";
import { extractRutFromText, normalizeRut, isValidRut, maskRut, formatRut, parseRutFromSpeech, extractRutHard, cleanAsrNoise } from "./utils.js";
import { getPatientByRut, getAndHoldNextSlot, scheduleAppointment } from "./legacy-compat/db-queries.js";
import { CallFinalizer } from "./services/call-finalizer.js";


// 🔧 MODULAR ENGINE IMPORTS (Phase 4)
import { SessionContext } from "./core/session-context.js";
import { SilencePolicy } from "./policies/silence-policy.js";
import { HoldPolicy } from "./policies/hold-policy.js";
import { TerminationPolicy } from "./policies/termination-policy.js";
import { ChannelControl } from "./ari/channel-control.js";
import { PlaybackModule } from "./ari/playback.js";
import { RecordingModule } from "./ari/recording.js";
import { EngineRunner } from "./core/engine-runner.js";
import { EngineLogger } from "./telemetry/engine-logger.js";
import { PhaseManager } from "./core/phase-manager.js";
import { playGreeting, playStillTherePrompt, recordUserTurn, sendSystemTextAndPlay, sendBvdaText, extractRutCandidate } from "./legacy/legacy-helpers.js";
import { shouldTransferToQueue, transferToQueue } from "./domain/transfers.js";
import { executeDomainAction } from "./legacy/legacy-actions.js";
import { PHASES, isSilentPhase } from "./domain/phases.js";
import { Guardrails } from "./policies/guardrails.js";
import { ivrSafetyDelay, shortTurnDelay, technicalWorkaroundDelay, recordingSettlementDelay } from "./async/sleep.js";
import { waitPlaybackFinished } from "./async/waiters.js";
import { pollUntil } from "./async/polling.js";
import { SkipInputOrchestrator } from "./orchestration/skip-input-orchestrator.js";
import { StrictModeOrchestrator } from "./orchestration/strict-mode.js";
import { NormalModeOrchestrator } from "./orchestration/normal-mode.js";
import { flowTrace } from "../telemetry/flow-trace.js";

// DB integration and RUT helpers are implemented in the query-enabled engine.

// ✅ DEFINICIÓN DE FASES Y REQUISITOS (MAPA DE CALOR)
// [EXTRACTED] PHASES and isSilentPhase moved to domain/phases.js



const execAsync = promisify(exec);

const VOICEBOT_PATH = config.paths.voicebot;
const ASTERISK_REC_PATH = config.paths.recordings;

const MIN_WAV_SIZE_BYTES = config.audio.minWavSizeBytes;
const MAX_TURNS_PER_CALL = 20;

/** Instrucción crítica para evitar que el bot invente datos si no han sido inyectados */
const ANTI_HALLUCINATION_GUARDRAIL = `
REGLAS CRÍTICAS DE SEGURIDAD:
1. NUNCA inventes RUTs o nombres de pacientes.
2. NUNCA infieras o completes números de RUT que el usuario no haya dicho explícitamente. 
3. Si el sistema te indica que el RUT es incompleto, solicita solo la parte faltante.
4. NUNCA des disponibilidad que no haya sido confirmada por el sistema.
5. Mantén respuestas breves y formales.
6. Si recibes una instrucción de sistema (ej. PACIENTE NO ENCONTRADO), repítela fielmente al usuario sin intentar "arreglarla".
`;
const MAX_SILENT_TURNS = config.engine.maxSilentTurns;
const MAX_RECORDING_MS = config.audio.maxRecordingMs;
const PLAYBACK_TIMEOUT_MS = config.audio.playbackTimeoutMs; ///duracion del audio de la respuesta
const SILENCE_THRESHOLD_SEC = config.audio.maxSilenceSeconds;
const TALKING_DEBOUNCE_MS = config.audio.talkingDebounceMs;
const MAX_WAIT_MS = config.audio.maxWaitMs;
const MIN_TALKING_EVENT = config.audio.minTalkingEvents;

const QUEUES_NAME = config.queues.nameQueue;
//const talkingDebounceMs = TALKING_DEBOUNCE_MS;

// [EXTRACTED] Helpers moved to legacy/legacy-helpers.js

// ---------------------------------------------------------
// 🔊 Reproducir con BARGE-IN y detección de interrupciones
// ---------------------------------------------------------
// [EXTRACTED] ARI Helpers replacement (see legacy-helpers.js)

// ---------------------------------------------------------
// 📝 Normalización y Extracción de RUT canónico
// ---------------------------------------------------------
// ✅ ACTUALIZADO: Usa parseRutFromSpeech() que maneja correctamente millones, miles y DV hablado
// [EXTRACTED] Logic Helpers replacement (see legacy-helpers.js)

// ---------------------------------------------------------
// 🎯 Saludo inicial usando texto
// ---------------------------------------------------------
// [EXTRACTED] Domain Helpers replacement (see legacy-helpers.js)

// [EXTRACTED] detectSpecialty moved to legacy-business.js

// ==========================================================================
// 🔧 MODULAR ENGINE (Phase 4) - Feature Flag Controlled
// ==========================================================================

/**
 * Modular Engine Bootstrap
 * Features:
 * - SessionContext (State Encapsulation)
 * - SilencePolicy (Fail-Closed)
 * - HoldPolicy (MOH w/ Feature Flag)
 * - ChannelControl (Idempotent ARI)
 * - PlaybackModule (Barge-In)
 * - RecordingModule (Validation)
 * - EngineRunner (Clean Loop)
 */
async function runModularEngine(ari, channel, ani, dnis, linkedId, promptFile, domainContext = null) {
  log('info', `🔧 [MODULAR ENGINE] Starting session for ${linkedId}`);

  flowTrace({
    traceId: linkedId,
    layer: 'ENGINE',
    flow: 'INIT',
    step: 'START_SESSION',
    depth: 1,
    module: 'voice-engine.js',
    fn: 'runModularEngine',
    action: 'INIT_SESSION',
    result: 'START'
  });

  // 1. Session & Modules
  const session = new SessionContext(linkedId, ani, dnis);
  const logger = new EngineLogger(session);

  const channelControl = new ChannelControl(ari, channel);
  const playback = new PlaybackModule(ari, config.audio);
  const recording = new RecordingModule(config.audio);

  const silencePolicy = new SilencePolicy({
    maxSilentTurns: config.engine.maxSilentTurns,
    failClosed: true
  });

  const holdPolicy = new HoldPolicy(config.engine.hold || {
    enabled: false,
    enterOnFirstSilence: true,
    maxHoldDurationMs: 30000,
    musicClass: 'default'
  });

  const terminationPolicy = new TerminationPolicy();
  const skipInputOrchestrator = new SkipInputOrchestrator({ ari, PHASES });
  const strictModeOrchestrator = new StrictModeOrchestrator({ ari });
  const normalModeOrchestrator = new NormalModeOrchestrator({ ari });
  const phaseManager = new PhaseManager(PHASES, logger);

  // 2. Engine Runner
  const runner = new EngineRunner({
    silencePolicy,
    holdPolicy,
    terminationPolicy,
    playback,
    recording,
    channelControl,
    phaseManager
  }, {
    maxTurns: config.engine.maxTurns || 20,
    PHASES
  }, logger);

  // 3. Legacy State (Compatibility)
  const conversationState = {
    active: true,
    turns: 0,
    history: [],
    lastAssistantText: "",
    repeatedCount: 0,
    startTime: new Date(),
    terminated: false
  };

  const audioState = {
    silentTurns: 0,
    successfulTurns: 0,
    hasSpeech: false
  };

  function botDisablesBargeIn(promptFileName) {
    try {
      const bots = config.bots || {};
      for (const key of Object.keys(bots)) {
        const b = bots[key];
        if (b && b.prompt === promptFileName) return !!b.disableBargeIn;
      }
    } catch (e) { }
    return false;
  }

  // 🧠 BUSINESS STATE OWNERSHIP: Domain decides initial state
  let businessState = {
    rutPhase: 'NONE',
    disableBargeIn: botDisablesBargeIn(promptFile)
  };

  if (domainContext && typeof domainContext.initialState === 'function') {
    log('info', '🧩 [MODULAR] Initializing State from Domain');
    const domainState = domainContext.initialState();
    businessState = { ...businessState, ...domainState };
  } else if (domainContext && domainContext.initialState && typeof domainContext.initialState === 'object') {
    businessState = { ...businessState, ...domainContext.initialState };
  }

  // 4. OpenAI & Prompting
  function promptRequiresDb(promptFileName) {
    try {
      const bots = config.bots || {};
      for (const key of Object.keys(bots)) {
        const b = bots[key];
        if (b && b.prompt === promptFileName) return !!b.requiresDb;
      }
    } catch (e) { }
    return false;
  }

  const necesitaBDD = promptRequiresDb(promptFile) ? 'sí' : 'no';
  const systemPrompt = buildPrompt(
    promptFile,
    {
      ANI: ani,
      DNIS: dnis,
      FechaHoy: new Date().toLocaleDateString('es-CL'),
      NecesitaBDD: necesitaBDD,
      NombreCompleto: '[DESCONOCIDO]',
      Edad: '[DESCONOCIDO]',
      EsAdultoMayor: '[DESCONOCIDO]',
      ProximaCita: '[SIN CITAS PENDIENTES]',
      DisponibilidadHoy: '[CONSULTAR AGENDA]',
      RutDetectado: '[NINGUNO]'
    },
    'inbound'
  );

  const openaiClient = new OpenAIRealtimeClientV3({
    voice: config.openai.voice,
    language: config.openai.language,
    model: config.openai.model,
    instructions: ANTI_HALLUCINATION_GUARDRAIL + "\n" + systemPrompt
  });

  await openaiClient.connect();

  // 5. Greeting
  // 5. Greeting
  if (domainContext && domainContext.domain) {
    log("info", "🌉 [MODULAR] Delegating Greeting to Domain (Turn 0)");
    const ctx = {
      transcript: "",
      sessionId: linkedId,
      ani,
      dnis,
      botName: domainContext.botName || 'default',
      state: businessState,
      ari,
      channel
    };

    try {
      const greetingResult = await domainContext.domain(ctx);
      if (ctx.state) Object.assign(businessState, ctx.state);

      if (greetingResult.ttsText) {
        if (greetingResult.ttsText.startsWith('sound:')) {
          const soundId = greetingResult.ttsText.replace('sound:voicebot/', '');
          await playWithBargeIn(ari, channel, soundId, openaiClient, { bargeIn: false });
        } else {
          // TTS dinámico
          const audioBuffer = await openaiClient.sendSystemText(greetingResult.ttsText);
          if (audioBuffer && audioBuffer.length > 0) {
            const rspId = `vb_greeting_${Date.now()}`;
            const rawPcmFile = `/tmp/${rspId}.pcm`;
            const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;
            fs.writeFileSync(rawPcmFile, audioBuffer);
            const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
            await execAsync(cmd);
            await playWithBargeIn(ari, channel, rspId, openaiClient, { bargeIn: false });
          }
        }
        if (conversationState) conversationState.history.push({ role: 'assistant', content: greetingResult.ttsText });
      }
    } catch (err) {
      log('error', `⚠️ [MODULAR] Domain Greeting Error: ${err.message}`);
    }
  } else {
    // Legacy Greeting
    const botConfig = config.bots[`voicebot_${promptFile.replace('.txt', '')}`] || config.bots['voicebot'] || {};
    try {
      if (botConfig.greetingFile || botConfig.greetingText) {
        businessState.rutPhase = 'WAIT_BODY';
        await playGreeting(ari, channel, openaiClient, botConfig, conversationState);
        log('info', '✅ [MODULAR] Legacy Greeting completed');
        await technicalWorkaroundDelay();
      }
    } catch (err) {
      log('warn', `⚠️ [MODULAR] Legacy Greeting error: ${err.message}`);
    }
  }

  // 6. Domain Processor Adapter
  const domainProcessor = async (recordResult, session, conversationState, audioState, businessState) => {
    // Process audio
    const responseBaseName = await processUserTurnWithOpenAI(recordResult.path, openaiClient);

    // Get transcript
    const transcript = await waitForTranscript(openaiClient);
    const assistantResponse = openaiClient.lastAssistantResponse || '';

    // History & State
    conversationState.history.push({ role: 'user', content: transcript });
    conversationState.history.push({ role: 'assistant', content: assistantResponse });

    let result = {
      responseFile: responseBaseName,
      assistantResponse: assistantResponse,
      transcript: transcript,
      critical: false,
      nextPhase: businessState.rutPhase || session.currentPhase
    };

    // 🧠 DOMAIN DELEGATION
    if (domainContext && domainContext.domain) {
      try {
        const ctx = {
          transcript,
          sessionId: linkedId,
          ani,
          dnis,
          botName: domainContext.botName || 'default',
          state: businessState,
          ari,
          channel
        };

        flowTrace({
          traceId: linkedId,
          layer: 'ENGINE',
          flow: businessState.rutPhase || 'UNKNOWN',
          step: session.currentPhase,
          depth: 1,
          module: 'voice-engine.js',
          fn: 'runLoop',
          action: 'DELEGATE_DOMAIN',
          result: domainContext.botName || 'domain'
        });

        const domainResult = await domainContext.domain(ctx);

        // Domain State Update
        if (ctx.state) Object.assign(businessState, ctx.state);

        // Engine Contract Fulfillment
        if (domainResult.ttsText) {
          await openaiClient.sendSystemText(domainResult.ttsText);
          conversationState.history.push({ role: 'assistant', content: domainResult.ttsText });
        }
        if (domainResult.shouldHangup) {
          conversationState.terminated = true;
        }
        result.nextPhase = domainResult.nextPhase || businessState.rutPhase;
        result.critical = false; // Domain handles logic

      } catch (err) {
        log('error', `❌ [MODULAR] Domain Logic Error: ${err.message}`);
      }
    } else {
      // 🔙 LEGACY FALLBACK REMOVED
      // The engine now fully relies on Domain Capsules.
      // If no domain is provided, it will strictly follow the prompt file or fail gracefully.
      log('debug', `[MODULAR] No domain context - skipping business logic`);
    }

    return result;
  };

  // 7. Run Loop
  try {
    await runner.runLoop(
      session,
      channel,
      openaiClient,
      domainProcessor,
      conversationState,
      audioState,
      businessState
    );
  } catch (err) {
    log('error', `❌ [MODULAR ENGINE] Fatal: ${err.message}`);
  } finally {
    openaiClient.disconnect();
    log('info', `🔚 [MODULAR ENGINE] Session ended`);
    await finalizeCallStorage(ari, channel, ani, dnis, linkedId, conversationState, audioState, businessState).catch(e => log('error', e.message));
  }
}

// ---------------------------------------------------------
// EXPORT: Sesión VoiceBot V3 MEJORADA CON PROMPTS
// ---------------------------------------------------------
export async function startVoiceBotSessionV3(ari, channel, ani, dnis, linkedId, promptFile, domainContext = null) {
  log(
    "info",
    `🤖[VB ENGINE V3] 🚀 Iniciando sesión MEJORADA ANI = ${ani} DNIS = ${dnis} LinkedId = ${linkedId} Prompt = ${promptFile}`
  );

  // 🔧 FEATURE FLAG: Modular Engine
  if (config.engine.useModularEngine) {
    log('info', '🔧 [ENGINE] Using MODULAR engine (Phase 4)');
    return runModularEngine(ari, channel, ani, dnis, linkedId, promptFile, domainContext);
  }

  log('info', '🔧 [ENGINE] Using LEGACY engine');

  if (domainContext && domainContext.domain) {
    log("info", `🔀 [ENGINE] DomainContext recibido: bot=${domainContext.botName || 'unknown'}, mode=${domainContext.mode || 'unknown'}`);
  } else {
    log("debug", `[ENGINE] Sin DomainContext - usando lógica genérica`);
  }

  if (!fs.existsSync(VOICEBOT_PATH)) {
    fs.mkdirSync(VOICEBOT_PATH, { recursive: true });
  }

  // =======================================================
  // PROMPT DINÁMICO DESDE TXT (nuevo)
  // =======================================================
  // Construir prompt base y añadir flag que indica si el prompt necesita BDD
  function promptRequiresDb(promptFileName) {
    try {
      const bots = config.bots || {};
      for (const key of Object.keys(bots)) {
        const b = bots[key];
        if (b && b.prompt === promptFileName) return !!b.requiresDb;
      }
    } catch (e) { }
    return false;
  }

  // 🛡️ Detectar si el bot deshabilita barge-in (para adultos mayores)
  function botDisablesBargeIn(promptFileName) {
    try {
      const bots = config.bots || {};
      for (const key of Object.keys(bots)) {
        const b = bots[key];
        if (b && b.prompt === promptFileName) return !!b.disableBargeIn;
      }
    } catch (e) { }
    return false;
  }

  const necesitaBDD = promptRequiresDb(promptFile) ? 'sí' : 'no';
  const botNoBargeIn = botDisablesBargeIn(promptFile); // 🛡️ Flag para deshabilitar barge-in

  // 🛡️ HARDENING OBLIGATORIO: Verificar helper isSilentPhase
  if (typeof isSilentPhase !== 'function') {
    log("error", '[ENGINE] CRITICAL: isSilentPhase helper no definido. Abortando para evitar crash.');
    return { shouldHangup: true };
  }


  const systemPrompt = buildPrompt(
    promptFile, // archivo dentro de inbound/prompts/
    {
      ANI: ani,
      DNIS: dnis,
      FechaHoy: new Date().toLocaleDateString('es-CL'),
      NecesitaBDD: necesitaBDD,
      // Valores por defecto para evitar alucinaciones si no hay datos iniciales
      NombreCompleto: '[DESCONOCIDO]',
      Edad: '[DESCONOCIDO]',
      EsAdultoMayor: '[DESCONOCIDO]',
      ProximaCita: '[SIN CITAS PENDIENTES]',
      DisponibilidadHoy: '[CONSULTAR AGENDA]',
      RutDetectado: '[NINGUNO]'
    },
    'inbound'
  );

  // Insertamos instrucciones en el cliente
  log("info", "📄 [PROMPT] Prompt cargado desde TXT para inbound");


  // =======================================================
  // 🧩 ESTADOS DE SESIÓN (Rediseño Estructura Mixta)
  // =======================================================
  const conversationState = {
    active: true,
    turns: 0,
    history: [], // [{role, content}]
    turns: 0,
    history: [], // [{role, content}]
    lastAssistantText: "",
    repeatedCount: 0,
    startTime: new Date(),
    terminated: false // V3-F04: Flag de sesión terminada
  };

  const audioState = {
    silentTurns: 0,
    successfulTurns: 0,
    hasSpeech: false
  };

  const businessState = {
    rutPhase: 'NONE', // 'NONE', 'WAIT_BODY', 'WAIT_DV', 'COMPLETE', 'ERROR'
    rutBody: null,
    rutDv: null,
    rutFormatted: null, // RUT completo formateado desde webhook FORMAT_RUT
    rutAttempts: 0,
    dni: null,
    patient: null,
    nombre_paciente: null, // Nombre desde webhook VALIDATE_PATIENT
    specialty: null,
    especialidad: null, // Especialidad detectada
    fecha_hora: null, // Fecha y hora desde webhook GET_NEXT_AVAILABILITY
    doctor_box: null, // Doctor desde webhook GET_NEXT_AVAILABILITY
    heldSlot: null,
    requiresStrictTts: false,
    disableBargeIn: botNoBargeIn // 🛡️ Deshabilitar barge-in si el bot lo requiere
  };

  const openaiClient = new OpenAIRealtimeClientV3({
    voice: config.openai.voice,
    language: config.openai.language,
    model: config.openai.model,
    instructions: ANTI_HALLUCINATION_GUARDRAIL + "\n" + systemPrompt
  });

  try {
    await openaiClient.connect();
  } catch (err) {
    log("error", `❌ [VB V3] No se pudo conectar a OpenAI Realtime: ${err.message}`);
  }
  // Mantener el comportamiento original del motor V3: no inyectar prompts específicos del DB.

  channel.on("StasisEnd", () => {
    log("info", `👋[VB V3] Canal colgó, finalizando sesión`);
    conversationState.active = false;
    openaiClient.disconnect();
  });

  // 🎙️ [MASTER] La grabación ahora es gestionada por MixMonitor en Asterisk (dialplan)
  // Se encarga de capturar el audio mezclado (bot + usuario) de forma robusta.
  log("info", `🎙️ [VB V3] MixMonitor activo para grabación master FULL-MIX`);
  /*
  try {
    const tenantId = process.env.TENANT_ID || "1";
    const { name: recName } = await startRecording(ari, channel, tenantId, linkedId, ani, dnis);
    if (recName) {
      log("info", `🎙️ [VB V3] Grabación principal garantizada: ${recName}`);
    }
  } catch (err) {
    log("warn", `⚠️ [VB V3] Error al asegurar grabación: ${err.message}`);
  }
  */

  // ✅ SALUDO INICIAL
  try {
    log("info", "👋 [VB V3] Reproduciendo saludo inicial...");

    // 🔀 DELEGACIÓN AL DOMINIO (si existe cápsula)
    if (domainContext && domainContext.domain) {
      log("info", "🌉 [ENGINE] Delegando saludo inicial al dominio (Turn 0)");

      const ctx = {
        transcript: "", // Sin input en Turn 0
        sessionId: linkedId,
        ani,
        dnis,
        botName: domainContext.botName || 'default',
        state: businessState,
        ari,
        channel
      };

      const greetingResult = await domainContext.domain(ctx);

      // Actualizar businessState con el estado del dominio
      if (ctx.state) {
        Object.assign(businessState, ctx.state);
      }

      // Si el dominio devuelve ttsText, reproducirlo
      if (greetingResult.ttsText) {
        // Verificar si es un sound file (formato: sound:voicebot/filename)
        if (greetingResult.ttsText.startsWith('sound:')) {
          const soundId = greetingResult.ttsText.replace('sound:voicebot/', '');
          log("info", `🔊 [ENGINE] Reproduciendo audio estático del dominio: ${soundId}`);
          await playWithBargeIn(ari, channel, soundId, openaiClient, { bargeIn: false });
        } else {
          // TTS dinámico
          log("info", `🤖 [ENGINE] Generando TTS del dominio: ${greetingResult.ttsText.substring(0, 50)}...`);
          const audioBuffer = await openaiClient.sendSystemText(greetingResult.ttsText);
          if (audioBuffer && audioBuffer.length > 0) {
            const rspId = `vb_greeting_${Date.now()}`;
            const rawPcmFile = `/tmp/${rspId}.pcm`;
            const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;
            fs.writeFileSync(rawPcmFile, audioBuffer);
            const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
            await execAsync(cmd);
            await playWithBargeIn(ari, channel, rspId, openaiClient, { bargeIn: false });
          }
        }

        // Registrar en historial
        if (conversationState) {
          conversationState.history.push({ role: 'assistant', content: greetingResult.ttsText });
        }
      }

      log("info", "✅ Saludo inicial completado (dominio)");
      await technicalWorkaroundDelay();
    } else {
      // 🔙 LEGACY: Usar lógica actual del engine
      log("info", "🔙 [ENGINE] Usando saludo legacy (sin dominio)");

      // Obtener configuración del bot basado en el promptFile
      let botConfig = {};
      const bots = config.bots || {};
      for (const key of Object.keys(bots)) {
        if (bots[key]?.prompt === promptFile) {
          botConfig = bots[key];
          break;
        }
      }

      // Inicializar fase RUT si el bot lo requiere
      businessState.rutPhase = 'WAIT_BODY';

      await playGreeting(ari, channel, openaiClient, botConfig, conversationState);
      log("info", "✅ Saludo inicial completado");
      await technicalWorkaroundDelay();
    }
  } catch (err) {
    log("warn", `⚠️ Error en saludo inicial: ${err.message} `);
  }

  for (let turn = 1; conversationState.active && turn <= MAX_TURNS_PER_CALL; turn++) {
    conversationState.turns = turn;

    // V3-F04: Guard global
    if (conversationState.terminated) {
      log("info", "[ENGINE] Sesión terminada, deteniendo loop");
      break;
    }



    log("info", `🔄[VB V3] Turno #${turn} (silencios: ${audioState.silentTurns}/${MAX_SILENT_TURNS})`);

    // Limpiar transcripciones previas para evitar falsos positivos en lógica de transferencia/RUT
    openaiClient.lastTranscript = "";
    openaiClient.lastAssistantResponse = "";
    let assistantResponse = "";

    // 🛡️ Verificar si el dominio indica que NO debe esperar voz (skipUserInput)
    // Esto es genérico: cualquier dominio puede indicar fases silenciosas
    // ✅ ORCHESTRATION: Check for silent phase / skip input / auto-advance (Phase 10)
    const skipResult = await skipInputOrchestrator.checkAndExecute(
      channel,
      openaiClient,
      domainContext,
      businessState,
      conversationState,
      turn,
      linkedId
    );

    if (skipResult.shouldSkip) {
      continue;
    }


    // =======================================================
    // 1) Turno inicial: Pregunta Proactiva del Bot (Solo turno 1)
    // =======================================================
    // ✅ ELIMINADO: El saludo inicial ahora incluye la solicitud de RUT
    // por lo que no necesitamos un turno proactivo separado.
    /*
    if (turn === 1 && !audioState.hasSpeech) {
      log("info", "🎤 [VB V3] Turno 1: Bot inicia solicitud de RUT (Protegido + Keep-Alive)");
  
      // 🔒 Turno 1 proactive: NO interrumpible (BVDA)
      // Usamos una ruta fija para el primer mensaje si es común, para evitar latencia de OpenAI en Turno 1
      const turn1Text = "Para comenzar, por favor indíqueme los números de su RUT, sin el dígito verificador.";
      const turn1CachePath = `${VOICEBOT_PATH}/turn1_rut_request.wav`;
  
      if (fs.existsSync(turn1CachePath)) {
        log('info', '📂 [CACHE] Usando audio local para solicitud de RUT Turno 1');
        await playWithBargeIn(ari, channel, 'turn1_rut_request', openaiClient, { bargeIn: false });
      } else {
        await sendBvdaText(ari, channel, openaiClient, turn1Text);
      }
    }
    */

    // =======================================================
    // 2) Esperar voz real
    // =======================================================
    // 🛡️ GUARDRAIL: Si es fase silenciosa, saltar grabación
    if (shouldSkipUserInput) {
      log("info", `🔇 [ENGINE] Fase silenciosa detectada (skipUserInput=true), saltando grabación explícitamente`);
      audioState.silentTurns = 0; // Resetear silencios para no triggerar timeout
      continue;
    }

    // 🛡️ GUARDRAIL: Permitir espera de voz en fases críticas incluso si Turn > 2
    // 🛡️ GUARDRAIL: Permitir espera de voz en fases críticas incluso si Turn > 2
    const currentPhaseDef = PHASES[businessState.rutPhase] || {};
    const isCriticalPhase = currentPhaseDef.isCritical || false;

    if ((turn <= 2 || isCriticalPhase) && audioState.silentTurns === 0) {
      log("info", "🎤 [VB V3] Esperando voz del usuario...");

      const voiceCheck = await waitForRealVoice(channel, {
        maxWaitMs: 4000,
        minTalkingEvents: 1
      });

      if (conversationState.terminated) {
        log("info", "[ENGINE] Sesión terminada mientras se esperaba voz. Abortando.");
        break;
      }

      if (!voiceCheck.detected) {
        log("warn", `🤫[VB V3] Sin voz detectada`);

        const silenceResult = silencePolicy.evaluate(session, false);

        if (silenceResult.action === 'prompt') {
          await playStillTherePrompt(ari, channel, openaiClient);
        } else if (silenceResult.action === 'goodbye') {
          await terminationPolicy.terminate(session, channelControl, 'max_silence');
          conversationState.active = false;
          break;
        }

        // Update local legacy state for logging consistency if needed, 
        // but session context is the source of truth now.
        audioState.silentTurns = session.consecutiveSilences;

        continue;
      } else {
        // Reset silence policy on voice detected
        silencePolicy.evaluate(session, true);
        audioState.silentTurns = 0;
      }

      log("info", `🟩[VB V3] Voz detectada(${voiceCheck.events} eventos) → iniciando grabación`);
    }

    // =======================================================
    // 2) Grabar turno del usuario
    // =======================================================
    const recResult = await recordUserTurn(channel, turn);

    // V3-F05: Post-Termination Guard
    if (conversationState.terminated) {
      log("info", "[ENGINE] Sesión terminada durante grabación. Ignorando resultado.");
      break;
    }

    if (!conversationState.active) {
      log("info", `🔚[VB V3] Sesión terminada durante grabación`);
      break;
    }

    if (!recResult.ok) {
      if (recResult.reason === "silence") {
        log("warn", `🤫[VB V3] Grabación vacía/silencio detected`);

        const silenceResult = silencePolicy.evaluate(session, false);

        if (silenceResult.action === 'prompt') {
          await playStillTherePrompt(ari, channel, openaiClient);
        } else if (silenceResult.action === 'goodbye') {
          await terminationPolicy.terminate(session, channelControl, 'max_silence');
          conversationState.active = false;
          break;
        }

        // Update local legacy state
        audioState.silentTurns = session.consecutiveSilences;
        continue;
      }

      log("warn", `⚠️[VB V3] Error grabación(${recResult.reason}), finalizando`);
      conversationState.active = false;
      break;
    }

    audioState.silentTurns = 0;
    audioState.successfulTurns++;
    audioState.hasSpeech = true;
    const userWavPath = recResult.path;

    // VALIDAR TAMAÑO MÍNIMO (Evitar procesar audios vacíos/planos)
    const stats = fs.statSync(userWavPath);
    if (stats.size < 40000) { // 40KB mínimo recomendado para RTP WebRTC real
      log("warn", `⚠️[VB V3] Turno con poco audio (${stats.size} bytes), posiblemente mudo.`);
      // Opcionalmente podrías decidir no enviarlo a OpenAI
    }

    log("info", `✅[VB V3] Audio válido recibido(turno exitoso #${audioState.successfulTurns}, ${stats.size} bytes)`);

    // =======================================================
    // 3) Procesamiento Central: STRICT MODE vs NORMAL MODE
    // =======================================================
    // Si estamos en una fase delicada (RUT), usamos STRICT MODE (Transcribe -> Logic -> TTS Explicit)
    // Si no, usamos NORMAL MODE (Realtime Audio-to-Audio)

    let responseBaseName = null;
    let transcript = "";

    // Nota: La verificación de fases silenciosas ya se hizo al inicio del turno
    // Si llegamos aquí, NO es fase silenciosa, así que procesamos normalmente

    // --- MODO ESTRICTO (RUT) ---
    // Nota: Si llegamos aquí, el dominio NO indicó skipUserInput (ya se procesó al inicio del turno)
    // Procesamos normalmente con transcripción de audio
    // --- MODO ESTRICTO (RUT) phase-driven ---
    // If we are in a phase that requires specific handling (Strict), delegation is now simplified.
    if (businessState.rutPhase !== 'NONE' && businessState.rutPhase !== 'COMPLETE' && businessState.rutPhase !== 'ERROR') {
      const strictResult = await strictModeOrchestrator.execute(
        channel,
        openaiClient,
        domainContext,
        businessState,
        conversationState,
        turn,
        linkedId,
        userWavPath,
        promptFile
      );

      if (strictResult.terminated) {
        conversationState.active = false;
      }

      // El modo estricto maneja su propio playback internamente, continuar loop
      continue;
    }
    // --- MODO NORMAL (Conversacional) ---
    else {
      const normalResult = await normalModeOrchestrator.execute(
        channel,
        openaiClient,
        businessState,
        conversationState,
        turn,
        linkedId,
        userWavPath
      );

      if (!normalResult.active) {
        conversationState.active = false;
        // Logic loop condition will handle termination, or we can break if needed
      }
    }






  }

  openaiClient.disconnect();
  log("info", `🔚[VB ENGINE V3] Sesión finalizada LinkedId = ${linkedId} (turnos exitosos: ${audioState.successfulTurns})`);

  // Finalizar almacenamiento e inicio de registro SQL (async)
  CallFinalizer.finalize(ari, channel, conversationState, audioState, businessState).catch(err => {
    log("error", `❌ [FINALIZE] Error fatal en finalización: ${err.message}`);
  });
}

/**
 * 🧱 HARD STATE MACHINE: Lógica determinista para RUT
 * Decide qué texto decir (TTS) y cómo cambiar de estado.
 */

// --- Helper Functions de Negocio ---
// [EXTRACTED] State Logic moved to legacy/legacy-business.js

// [EXTRACTED] Business Logic moved to legacy/legacy-business.js
