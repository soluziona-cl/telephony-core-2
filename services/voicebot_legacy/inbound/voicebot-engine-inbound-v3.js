// =========================================================
// VOICEBOT ENGINE V3 - Ultra-Low Latency con Barge-In Real
// =========================================================
// ✅ Sesión WebSocket persistente (sin reconexión por turno)
// ✅ Barge-in real con cancelación de respuesta OpenAI
// ✅ Detección de silencio agresiva (1.5s vs 4s)
// ✅ Timeouts más cortos
// ✅ VAD (Voice Activity Detection) mejorado
// =========================================================

import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { OpenAIRealtimeClientV3 } from "../shared/openai-realtime-client-v3.js";
import { log } from "../../../lib/logger.js";
import { startRecording, stopRecording } from "../../../services/telephony-recorder.js";
import { inboundConfig as config } from "./voicebot-config-inbound.js";
import { buildPrompt } from "../shared/prompt-builder.js";
import { extractRutFromText, normalizeRut, isValidRut, maskRut, formatRut, parseRutFromSpeech, extractRutHard, cleanAsrNoise } from "../shared/utils.js";
import { getPatientByRut, getAndHoldNextSlot, scheduleAppointment } from "../shared/db-queries.js";
import { sql, poolPromise } from "../../../lib/db.js";
import { classifyInput } from "../shared/openai-classifier.js";
import { classifyConfirmSimple } from "../shared/confirm-classifier.js";
import path from "path";
// DB integration and RUT helpers are implemented in the query-enabled engine.

// ✅ DEFINICIÓN DE FASES Y REQUISITOS (MAPA DE CALOR)
const PHASES = {
  // Fases de Captura (Requieren Input Obligatorio)
  'WAIT_BODY': { requiresInput: true },
  'WAIT_DV': { requiresInput: true },
  'CONFIRM': { requiresInput: true },
  'ASK_SPECIALTY': { requiresInput: true },
  'PARSE_SPECIALTY': { requiresInput: true }, // A veces es interna, pero si falló requiere input
  'CONFIRM_APPOINTMENT': { requiresInput: true },

  // Fases Informativas / Procesamiento (No requieren Input - Silenciosas)
  'CHECK_AVAILABILITY': { requiresInput: false },
  'INFORM_AVAILABILITY': { requiresInput: false },
  'FINALIZE': { requiresInput: false },
  'COMPLETE': { requiresInput: false },
  'FAILED': { requiresInput: false }
};

/** 
 * Helper para detectar fases silenciosas 
 * @param {string} phase 
 * @returns {boolean}
 */
function isSilentPhase(phase) {
  const p = PHASES[phase];
  return p ? !p.requiresInput : false;
}



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

function shouldTransferToQueue(transcript, assistantResponse = "") {
  if (!transcript) {
    // Si no hay transcript, verificar en la respuesta del asistente
    const lowerResponse = assistantResponse.toLowerCase();
    const transferPhrases = [
      'te conecto con un ejecutivo',
      'te transfiero con un ejecutivo',
      'conectando con ejecutivo',
      'en breve el ejecutivo',
      'te estoy conectando'
    ];

    const detected = transferPhrases.some(phrase => lowerResponse.includes(phrase));
    if (detected) {
      log("info", `🎯 [Transferencia] Detectada en respuesta del asistente: "${assistantResponse}"`);
    }
    return detected;
  }

  const lowerTranscript = transcript.toLowerCase();

  const TRANSFER_KEYWORDS = [
    'ejecutivo', 'operador', 'agente', 'representante', 'asesor', 'vendedor',
    'humano', 'persona', 'hablar con alguien', 'hablar con una persona',
    'derivar', 'transferir', 'pasar con', 'contactar con',
    'colaborador', 'especialista', 'consultor', 'asistente humano',
    'atencion personal', 'atencion directa', 'servicio al cliente',
    'quiero hablar con', 'necesito hablar con', 'deseo hablar con',
    'me comunico con', 'me pongo con', 'me conectas con'
  ];

  const detected = TRANSFER_KEYWORDS.some(keyword => {
    // Usar regex para coincidencia de palabra completa para evitar "Consultorio" -> "consultor"
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    return regex.test(lowerTranscript);
  });

  if (detected) {
    log("info", `🎯 [Transferencia] Palabra clave detectada: "${transcript}"`);
  }

  return detected;
}

/** Detecta si el asistente se está despidiendo */
function shouldEndCall(text) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  const goodbyePhrases = [
    "que tenga un excelente día",
    "que tenga un buen día",
    "hasta luego",
    "adiós",
    "me despido",
    "un gusto haberle ayudado",
    "nos vemos",
    "finalizar llamada"
  ];
  return goodbyePhrases.some(phrase => lowerText.includes(phrase));
}


if (!fs.existsSync(VOICEBOT_PATH)) {
  fs.mkdirSync(VOICEBOT_PATH, { recursive: true });
}

// =======================================================
// 🎤 DETECCIÓN DE VOZ MEJORADA - Más tolerante
// =======================================================
async function waitForRealVoice(channel, {
  maxWaitMs = MAX_WAIT_MS, // Aumentado de 2s a 4s
  minTalkingEvents = MIN_TALKING_EVENT // Mínimo eventos de voz detectados
} = {}) {


  return new Promise((resolve) => {
    let talkingCount = 0;
    const start = Date.now();

    const onTalking = (evt, chan) => {
      if (!chan || chan.id !== channel.id) return;
      talkingCount++;

      log("debug", `🎤 Evento de voz detectado (#${talkingCount})`);

      if (talkingCount >= minTalkingEvents) {
        cleanup();
        return resolve({ detected: true, events: talkingCount });
      }
    };

    const cleanup = () => {
      channel.removeListener("ChannelTalkingStarted", onTalking);
    };

    channel.on("ChannelTalkingStarted", onTalking);

    const timer = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= maxWaitMs) {
        clearInterval(timer);
        cleanup();
        log("warn", `⏱️ Timeout esperando voz (${elapsed}ms)`);
        return resolve({ detected: false, events: talkingCount });
      }
    }, 100);
  });
}

// ---------------------------------------------------------
// Helper: Esperar archivo
// ---------------------------------------------------------
async function waitForFile(path, timeoutMs = 3000, intervalMs = 100) {
  const start = Date.now();

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      try {
        if (fs.existsSync(path)) {
          const stats = fs.statSync(path);
          if (stats.size > 0) {
            clearInterval(timer);
            log("debug", `✅ Archivo encontrado: ${path} (${stats.size} bytes)`);
            return resolve(true);
          }
        }

        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          log("warn", `⏱️ Timeout esperando archivo: ${path}`);
          return resolve(false);
        }
      } catch (err) {
        log("debug", `Error checking file: ${err.message}`);
      }
    }, intervalMs);
  });
}

// ---------------------------------------------------------
// Helper: Validación de grabación
// ---------------------------------------------------------
function isValidRecording(path) {
  try {
    if (!fs.existsSync(path)) {
      log("warn", `❌ Archivo no existe: ${path}`);
      return false;
    }

    const stats = fs.statSync(path);

    // FILTRO CRÍTICO: Ignorar audios menores a 6KB (WebRTC noise / micro-turns)
    if (stats.size < 6000) {
      log("warn", `🤫 [VB V3] Audio ignorado por tamaño insuficiente: ${stats.size} bytes`);
      return false;
    }

    log("debug", `📁 Tamaño grabación: ${stats.size} bytes`);
    return true;
  } catch (err) {
    log("error", `❌ Error validando grabación: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------
// Helper: Convertir WAV
// ---------------------------------------------------------
async function convertWavToWav8000(inputWav, outputWav) {
  try {
    const cmd = `ffmpeg -y -i "${inputWav}" -ar 8000 -ac 1 -codec:a pcm_mulaw "${outputWav}"`;
    log("debug", `[FFmpeg] ${cmd}`);
    await execAsync(cmd);
  } catch (err) {
    throw new Error(`FFmpeg conversion failed: ${err.message}`);
  }
}

// ---------------------------------------------------------
// 🔊 Reproducir con BARGE-IN y detección de interrupciones
// ---------------------------------------------------------
async function playWithBargeIn(ari, channel, fileBaseName, openaiClient, options = {}) {
  // 🛡️ Protección: Verificar que el canal existe antes de reproducir
  try {
    const channelState = await channel.get();
    if (!channelState || channelState.state === 'Down') {
      log("debug", `🔇 [VB V3] Canal no disponible para playback (estado: ${channelState?.state || 'null'}), omitiendo`);
      if (openaiClient) openaiClient.isPlaybackActive = false;
      return { reason: "channel_down" };
    }
  } catch (err) {
    // Si no podemos obtener el estado, asumimos que el canal no existe
    log("debug", `🔇 [VB V3] No se pudo verificar estado del canal: ${err.message}, omitiendo playback`);
    if (openaiClient) openaiClient.isPlaybackActive = false;
    return { reason: "channel_not_found" };
  }

  const allowBargeIn = options.bargeIn !== false;
  const media = `sound:voicebot/${fileBaseName}`;

  const playback = ari.Playback();

  log("info", `🔊 [VB V3] Reproduciendo (barge-in ${allowBargeIn ? 'si' : 'no'}): ${media}`);
  if (openaiClient) openaiClient.isPlaybackActive = true;


  return new Promise((resolve) => {
    let bargedIn = false;
    let finished = false;
    let talkingTimer = null;
    const startedAt = Date.now();

    const talkingHandler = (event, chan) => {
      if (!chan || chan.id !== channel.id) return;
      if (finished || !allowBargeIn) return;

      if (talkingTimer) clearTimeout(talkingTimer);

      talkingTimer = setTimeout(() => {
        if (finished) return;

        log("info", `🗣️ [VB V3] 🔥 BARGE-IN DETECTADO → Usuario interrumpió`);
        bargedIn = true;

        if (openaiClient && openaiClient.activeResponseId) {
          openaiClient.cancelCurrentResponse("user_barge_in");
        }

        playback.stop().catch((err) =>
          log("warn", `⚠️ Error deteniendo playback: ${err.message}`)
        );
      }, TALKING_DEBOUNCE_MS);
    };

    const cleanup = () => {
      finished = true;
      if (talkingTimer) clearTimeout(talkingTimer);
      channel.removeListener("ChannelTalkingStarted", talkingHandler);
    };

    channel.on("ChannelTalkingStarted", talkingHandler);

    playback.on("PlaybackFinished", () => {

      if (finished) return;
      if (openaiClient) openaiClient.isPlaybackActive = false;
      log("debug", `✅ Playback completado: ${media}`);
      cleanup();
      resolve({ reason: bargedIn ? "barge-in" : "finished" });
    });

    playback.on("PlaybackStopped", () => {
      if (finished) return;
      if (openaiClient) openaiClient.isPlaybackActive = false;
      log("debug", `🛑 Playback detenido: ${media}`);
      cleanup();
      resolve({ reason: bargedIn ? "barge-in" : "stopped" });
    });

    playback.on("PlaybackFailed", (evt) => {
      if (finished) return;
      if (openaiClient) openaiClient.isPlaybackActive = false;
      log("error", `❌ Playback falló: ${JSON.stringify(evt)}`);
      cleanup();
      resolve({ reason: "failed" });
    });

    const timeoutTimer = setInterval(() => {
      if (finished) {
        clearInterval(timeoutTimer);
        return;
      }
      if (Date.now() - startedAt > PLAYBACK_TIMEOUT_MS) {
        log("warn", `⏰ Timeout en playback: ${media}`);
        playback.stop().catch((err) =>
          log("warn", `⚠️ Error timeout playback: ${err.message}`)
        );
        clearInterval(timeoutTimer);
      }
    }, 500);

    channel
      .play({ media }, playback)
      .catch((err) => {
        if (finished) return;
        log("error", `❌ No se pudo iniciar playback: ${err.message}`);
        cleanup();
        resolve({ reason: "error" });
      });
  });
}

// ---------------------------------------------------------
// 🎙️ Grabar turno
// ---------------------------------------------------------
async function recordUserTurn(channel, turnNumber) {
  const recId = `vb_${Date.now()}`;
  const wavFile = `${ASTERISK_REC_PATH}/${recId}.wav`;

  log("info", `🎙️ [VB V3] Iniciando grabación turno #${turnNumber}: ${recId}`);

  let recordingObj;
  try {
    recordingObj = await channel.record({
      name: recId,
      format: "wav",
      beep: false,
      maxSilenceSeconds: SILENCE_THRESHOLD_SEC,
      silenceThreshold: config.audio.silenceThreshold,
      ifExists: "overwrite"
    });
  } catch (err) {
    log("error", `❌ Error grabación: ${err.message}`);
    return { ok: false, reason: "record-start-failed" };
  }

  const startedAt = Date.now();

  const result = await new Promise((resolve) => {
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      recordingObj.removeAllListeners("RecordingFinished");
      recordingObj.removeAllListeners("RecordingFailed");
    };

    recordingObj.on("RecordingFinished", () => {
      if (finished) return;
      const duration = ((Date.now() - startedAt) / 1000).toFixed(2);
      log("info", `🎙️ [VB V3] Grabación finalizada: ${recId}.wav (${duration}s)`);
      cleanup();
      resolve({ ok: true, reason: "finished", duration });
    });

    recordingObj.on("RecordingFailed", (evt) => {
      if (finished) return;
      log("error", `❌ [VB V3] RecordingFailed: ${JSON.stringify(evt)}`);
      cleanup();
      resolve({ ok: false, reason: "record-failed" });
    });

    const timer = setInterval(() => {
      if (finished) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - startedAt > MAX_RECORDING_MS) {
        log("warn", `⏰ Timeout grabación: ${recId}`);
        try {
          recordingObj
            .stop()
            .catch((err) => log("warn", `⚠️ Error timeout: ${err.message}`));
        } catch (err) {
          log("warn", `⚠️ Excepción timeout: ${err.message}`);
        }
        clearInterval(timer);
      }
    }, 500);
  });

  const exists = await waitForFile(wavFile, 3000, 100);
  if (!exists) {
    log("error", `❌ Archivo no existe: ${wavFile}`);
    return { ok: false, reason: "file-not-found" };
  }

  if (!isValidRecording(wavFile)) {
    // Si el audio es muy pequeño, no lo enviamos a OpenAI ni hacemos fallback
    return { ok: false, reason: "silence", path: wavFile };
  }

  log("info", `✅ Grabación válida: ${wavFile} (${result.duration}s)`);
  return { ok: true, reason: "ok", path: wavFile, recId };
}

// ---------------------------------------------------------
// 📝 Normalización y Extracción de RUT canónico
// ---------------------------------------------------------
// ✅ ACTUALIZADO: Usa parseRutFromSpeech() que maneja correctamente millones, miles y DV hablado
function extractRutCandidate(transcript = "") {
  if (!transcript) return { body: null, dv: null, allDigits: "" };

  // Usar el nuevo parser mejorado
  const parsed = parseRutFromSpeech(transcript);

  // Mantener compatibilidad con formato anterior
  const allDigits = parsed.body ? (parsed.body + (parsed.dv || "")) : "";

  return {
    body: parsed.body ? String(parsed.body) : null,
    dv: parsed.dv || null,
    allDigits: allDigits,
    // Campos adicionales para debugging
    reason: parsed.reason,
    ok: parsed.ok
  };
}

function rutExpectedDV(body) {
  const s = body.split("").reverse().map(Number);
  const factors = [2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i] * factors[i % factors.length];
  const mod = 11 - (sum % 11);
  if (mod === 11) return "0";
  if (mod === 10) return "k";
  return String(mod);
}

// ---------------------------------------------------------
// 🤖 Procesar turno con OpenAI
// ---------------------------------------------------------
async function processUserTurnWithOpenAI(userWavPath, openaiClient) {
  const recId = `vb_${Date.now()}`;
  const processedUserWav = `${VOICEBOT_PATH}/${recId}_8k.wav`;

  try {
    await convertWavToWav8000(userWavPath, processedUserWav);
  } catch (err) {
    log("error", `❌ [VB V3] Error conversión input→8k: ${err.message}`);
    return null;
  }

  let responsePcm;
  try {
    log("debug", `🔍 [DEBUG] Antes de enviar audio - lastTranscript: "${openaiClient.lastTranscript}"`);
    responsePcm = await openaiClient.sendAudioAndWait(processedUserWav);
    log("debug", `🔍 [DEBUG] Después de enviar audio - lastTranscript: "${openaiClient.lastTranscript}"`);
  } catch (err) {
    log("error", `❌ [VB V3] OpenAI error: ${err.message}`);
    return null;
  }

  if (!responsePcm || !responsePcm.length) {
    log("warn", `⚠️ [VB V3] OpenAI devolvió audio vacío`);
    return null;
  }

  const rspId = `vb_rsp_${Date.now()}`;
  const rawPcmFile = `/tmp/${rspId}.pcm`;
  const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

  try {
    fs.writeFileSync(rawPcmFile, responsePcm);
  } catch (err) {
    log("error", `❌ Error guardando PCM: ${err.message}`);
    return null;
  }

  try {
    const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
    log("debug", `[FFmpeg] ${cmd}`);
    await execAsync(cmd);
  } catch (err) {
    log("error", `❌ Error PCM→WAV: ${err.message}`);
    return null;
  }

  log("info", `✅ Respuesta creada: ${finalWavFile}`);
  return rspId;
}

// ---------------------------------------------------------
// 🎯 Saludo inicial usando texto
// ---------------------------------------------------------
async function playGreeting(ari, channel, openaiClient, botConfig = {}, conversationState = null) {
  log("info", "👋 [VB V3] Preparando saludo inicial...");

  // Texto del saludo a registrar (Dinámico desde config o default)
  const defaultGreeting = "Hola, Bienvenido.";
  let greetingText = botConfig.greetingText || defaultGreeting;

  // Priorizar audio estático si el bot tiene greetingFile configurado
  if (botConfig.greetingFile) {
    const staticFileName = botConfig.greetingFile;
    const staticFilePath = `${VOICEBOT_PATH}/${staticFileName}.wav`;

    if (fs.existsSync(staticFilePath)) {
      log('info', `📂 [STATIC] Usando saludo estático: ${staticFileName}.wav`);
      await playWithBargeIn(ari, channel, staticFileName, openaiClient, { bargeIn: false });

      // Registrar en historial si se pasó el estado
      if (conversationState) {
        conversationState.history.push({ role: 'assistant', content: greetingText });
      }

      await new Promise(r => setTimeout(r, 300)); // Pausa de confort
      return true;
    } else {
      log('warn', `⚠️ [STATIC] Archivo no encontrado: ${staticFilePath}, generando con IA...`);
    }
  }

  // Fallback: Generar con OpenAI si no hay estático o no existe
  try {
    log("info", "🤖 [VB V3] Generando saludo con OpenAI...");

    const audioBuffer = await openaiClient.sendSystemText(greetingText);

    if (!audioBuffer || audioBuffer.length === 0) {
      log("warn", "⚠️ No se recibió audio del saludo");
      return false;
    }

    const rspId = `vb_greeting_${Date.now()}`;
    const rawPcmFile = `/tmp/${rspId}.pcm`;
    const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

    fs.writeFileSync(rawPcmFile, audioBuffer);

    const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
    log("debug", `[FFmpeg] ${cmd}`);
    await execAsync(cmd);

    log("info", `✅ Saludo generado: ${finalWavFile}`);

    // FASE 3: Reproducir SALUDO INICIAL sin barge-in para asegurar que se escuche la presentación
    await playWithBargeIn(ari, channel, rspId, openaiClient, { bargeIn: false });

    // Registrar en historial si se pasó el estado
    if (conversationState) {
      conversationState.history.push({ role: 'assistant', content: greetingText });
    }

    log("info", "✅ Saludo inicial completado");
    return true;

  } catch (err) {
    log("error", `❌ Error generando saludo: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------
// 💬 Prompt "¿Sigues ahí?" - TTS ESTÁTICO (NO OpenAI)
// ---------------------------------------------------------
async function playStillTherePrompt(ari, channel, openaiClient, currentPhase = null) {
  log("info", `❓ [VB V3] Reproduciendo prompt estático: ¿Sigue en línea?`);

  try {
    // 🔥 [KEEP-ALIVE]
    if (channel) {
      await channel.play({ media: 'sound:silence/1' });
    }

    // ✅ USAR TTS ESTÁTICO PURO (synthesizeSpeech)
    // Usamos synthesizeSpeech en lugar de sendTextAndWait para evitar que el LLM
    // interprete esto como un turno de conversación y alucine respuestas.
    const staticText = "¿Sigue en línea? Por favor, dígame sí o no.";
    const audioBuffer = await openaiClient.synthesizeSpeech(staticText);

    if (!audioBuffer || audioBuffer.length === 0) {
      log("warn", "⚠️ No se recibió audio del prompt estático");
      return false;
    }

    const rspId = `vb_still_there_${Date.now()}`;
    const rawPcmFile = `/tmp/${rspId}.pcm`;
    const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

    fs.writeFileSync(rawPcmFile, audioBuffer);

    const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
    await execAsync(cmd);

    // 🔒 Seguridad: No interrumpible
    // Pasamos un "dummy" responseBaseName para evitar el error 'voicebot/null' en Strict Mode,
    // aunque al ser bargeIn: false, el riesgo es menor, pero mantenemos consistencia.
    await playWithBargeIn(ari, channel, rspId, openaiClient, { bargeIn: false });
    await new Promise(r => setTimeout(r, 600));

    log("info", "✅ Prompt estático '¿Sigue en línea?' completado");
    return true;

  } catch (err) {
    log("error", `❌ Error en prompt estático '¿Sigue en línea?': ${err.message}`);
    return false;
  }
}

// function playComprendoPrompt removed for better UX

/** Helper: enviar texto del sistema, generar audio y reproducir con barge-in */
async function sendSystemTextAndPlay(ari, channel, openaiClient, text, options = {}) {
  try {
    // 🔥 [KEEP-ALIVE] Mantener canal activo mientras OpenAI genera audio
    // Reproducimos 1 segundo de silencio para evitar que Asterisk cuelgue por "idle"
    if (channel) {
      log('debug', '⏱️ [KEEP-ALIVE] Iniciando silencio para mantener canal activo...');
      try {
        await channel.play({ media: 'sound:silence/1' });
      } catch (e) {
        log('warn', `⚠️ No se pudo reproducir silencio de keep-alive: ${e.message}`);
      }
    }

    const audioBuffer = await openaiClient.sendSystemText(text);
    if (!audioBuffer || audioBuffer.length === 0) {
      log('warn', '⚠️ No se recibió audio del system text');
      return false;
    }

    const rspId = `vb_sys_${Date.now()}`;
    const rawPcmFile = `/tmp/${rspId}.pcm`;
    const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

    fs.writeFileSync(rawPcmFile, audioBuffer.audioBuffer || audioBuffer);

    const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
    await execAsync(cmd);

    await playWithBargeIn(ari, channel, rspId, openaiClient, options);
    // ✅ Seguridad IVR: Pequeña pausa tras playback antes de abrir micrófono (evitar eco/barge-in accidental)
    if (options.bargeIn === false) {
      log("debug", "⏱️ [ORCHESTRATION] Aplicando pausa de seguridad tras audio no-interrumpible");
      await new Promise(r => setTimeout(r, 600));
    }
    return true;
  } catch (err) {
    log('error', `sendSystemTextAndPlay error: ${err.message}`);
    return false;
  }
}

/** Helper: BVDA (Business Value Delivering Audio) - No interrumplible */
async function sendBvdaText(ari, channel, openaiClient, text) {
  log("info", `🛡️ [BVDA] Enviando mensaje protegido (no barge-in): ${text.slice(0, 50)}...`);
  return sendSystemTextAndPlay(ari, channel, openaiClient, text, { bargeIn: false });
}

// ---------------------------------------------------------
// 🔄 Transferir a cola de ventas
// ---------------------------------------------------------
async function transferToQueue(ari, channel, queueName = "cola_ventas") {
  log("info", `📞 [VB V3] INICIANDO Transferencia a cola: ${queueName}`);
  const channelId = channel.id;
  const channelState = channel.state;
  const linkedId = channel.linkedid;

  log("debug", `🔍 [Transferencia] Canal ID: ${channelId}, Estado: ${channelState}, LinkedId: ${linkedId}`);

  try {
    // 1. Reproducir un tono o mensaje breve si es necesario
    // (Opcional, Asterisk suele manejarlo en la cola)

    // 2. Redirigir el canal a la extensión de la cola en el dialplan
    // Usamos el contexto definido en extensions.conf para colas (ej: 'queues')
    // Si no tienes un contexto específico, puedes usar 'from-internal' o similar.
    log("info", `🔄 [Transferencia] Redirigiendo a contexto: queues, extensión: ${queueName}`);

    await channel.continueInDialplan({
      context: 'queues',
      extension: queueName,
      priority: 1
    });

    log("info", `✅ [VB V3] Transferencia a ${queueName} iniciada`);
    return true;
  } catch (err) {
    log("error", `❌ [VB V3] Error en transferencia: ${err.message}`);
    return false;
  }
}

/** Helper: Detecta especialidad en un texto */
function detectSpecialty(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  const specialties = [
    { key: "Medicina General", synonyms: ["medicina general", "médico general", "doctor general", "medicina"] },
    { key: "Odontología", synonyms: ["odontología", "dentista", "odontólogo", "odontologo", "dientes"] },
    { key: "Pediatría", synonyms: ["pediatría", "pediatra", "niños", "niño", "niña"] },
    { key: "Matrona", synonyms: ["matrona", "obstetricia", "embarazo"] },
    { key: "Kinesiología", synonyms: ["kinesiología", "kinesiólogo", "kinesióloga", "kinesis", "ejercicios"] },
    { key: "Nutricionista", synonyms: ["nutricionista", "nutrición", "dieta", "peso"] },
    { key: "Psicología", synonyms: ["psicología", "psicólogo", "psicóloga", "terapia"] },
    { key: "Enfermería", synonyms: ["enfermería", "enfermero", "enfermera", "curaciones", "vacunas"] },
    { key: "Oftalmología", synonyms: ["oftalmología", "oftalmólogo", "vista", "ojos"] },
    { key: "Ginecología", synonyms: ["ginecología", "ginecólogo", "mujer"] },
    { key: "Cardiología", synonyms: ["cardiología", "cardiólogo", "corazón", "corazon"] },
    { key: "Dermatología", synonyms: ["dermatología", "dermatólogo", "piel"] }
  ];

  for (const s of specialties) {
    for (const syn of s.synonyms) {
      if (lower.includes(syn)) return s.key;
    }
  }
  return null;
}
// ---------------------------------------------------------
// EXPORT: Sesión VoiceBot V3 MEJORADA CON PROMPTS
// ---------------------------------------------------------
export async function startVoiceBotSessionV3(ari, channel, ani, dnis, linkedId, promptFile, domainContext = null) {
  log(
    "info",
    `🤖[VB ENGINE V3] 🚀 Iniciando sesión MEJORADA ANI = ${ani} DNIS = ${dnis} LinkedId = ${linkedId} Prompt = ${promptFile}`
  );

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

    // Obtener configuración del bot basado en el promptFile
    let botConfig = {};
    const bots = config.bots || {};
    for (const key of Object.keys(bots)) {
      if (bots[key]?.prompt === promptFile) {
        botConfig = bots[key];
        break;
      }
    }

    // Inicializar fase RUT si el bot lo requiere (ej: saludo que pide RUT)
    // Asumimos que si estamos en este flujo, el saludo inicial ya invita a dar el RUT
    // o el primer turno lo hará. Por defecto, podríamos iniciar en WAIT_BODY si el prompt lo sugiere.
    businessState.rutPhase = 'WAIT_BODY'; // Asumimos intención de pedir RUT desde el inicio


    await playGreeting(ari, channel, openaiClient, botConfig, conversationState);
    log("info", "✅ Saludo inicial completado");
    await new Promise(resolve => setTimeout(resolve, 500));
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

    // V3-F01: Fase COMPLETE es terminal real
    if (businessState.rutPhase === 'COMPLETE') {
      log("info", "[ENGINE] COMPLETE detectado, evitando loop de turnos (V3-F01)");
      conversationState.active = false;
      conversationState.terminated = true;
      // Asegurar hangup si no se hizo antes
      try { await channel.hangup(); } catch (e) { }
      break;
    }

    log("info", `🔄[VB V3] Turno #${turn} (silencios: ${audioState.silentTurns}/${MAX_SILENT_TURNS})`);

    // Limpiar transcripciones previas para evitar falsos positivos en lógica de transferencia/RUT
    openaiClient.lastTranscript = "";
    openaiClient.lastAssistantResponse = "";
    let assistantResponse = "";

    // 🛡️ Verificar si el dominio indica que NO debe esperar voz (skipUserInput)
    // Esto es genérico: cualquier dominio puede indicar fases silenciosas
    let shouldSkipUserInput = false;
    let skipUserInputResult = null; // Guardar resultado para no invocar dominio dos veces

    // ✅ DEFINICIÓN DE FASES (Usando global PHASES)
    // const PHASES = ... (Movido a scope global)


    if (domainContext && domainContext.domain) {
      // 🛡️ PRE-CHECK: Si la fase actual requiere input explícito, NO preguntar al dominio
      // Esto evita que el dominio procese input="" como válido en fases de captura
      const phaseConfig = PHASES[businessState.rutPhase];
      const phaseRequiresInput = phaseConfig ? phaseConfig.requiresInput : false; // Default: false (assumes silent/internal)

      // Excepción: Si es el PRIMER turno, permitimos que el dominio decida (ej: saludo que no espera respuesta)
      // Pero si estamos en WAIT_BODY, WAIT_DV, CONFIRM, etc., y NO es inicio absoluto, exigimos voz.

      if (phaseRequiresInput && turn > 1) {
        log("info", `🛡️ [ENGINE] Fase ${businessState.rutPhase} requiere input. Saltando verificación de skipUserInput.`);
        shouldSkipUserInput = false;
      } else {
        // Invocar dominio para verificar si la fase actual requiere skipUserInput
        const ctx = {
          transcript: "", // Sin transcript aún, solo consulta
          sessionId: linkedId,
          ani,
          dnis,
          botName: domainContext.botName || 'default',
          state: businessState
        };

        log("info", `[DOMAIN] Consultando dominio para fase: ${businessState.rutPhase}, botName: ${ctx.botName}`);
        skipUserInputResult = await domainContext.domain(ctx);

        // Actualizar businessState con el estado del dominio
        if (ctx.state) {
          Object.assign(businessState, ctx.state);
        }

        // Si el dominio indica skipUserInput, NO esperar voz
        shouldSkipUserInput = skipUserInputResult.skipUserInput === true;
      }

      if (shouldSkipUserInput) {
        log("info", `🔇 [ENGINE] Dominio indica skipUserInput=true para fase ${businessState.rutPhase}, ejecutando inmediatamente sin esperar voz`);

        log("info", `[DOMAIN] Respuesta del dominio: nextPhase=${skipUserInputResult.nextPhase || 'none'}, ttsText=${skipUserInputResult.ttsText ? 'presente' : 'ausente'}, skipUserInput=${skipUserInputResult.skipUserInput}, action=${skipUserInputResult.action ? skipUserInputResult.action.type : 'null'}`);

        // Ejecutar acción del dominio
        if (skipUserInputResult.action && skipUserInputResult.action.type) {
          log("info", `[DOMAIN] Ejecutando acción: ${skipUserInputResult.action.type}`);

          switch (skipUserInputResult.action.type) {
            case 'SET_STATE':
              if (skipUserInputResult.action.payload.updates) {
                Object.assign(businessState, skipUserInputResult.action.payload.updates);
                log("info", `[DOMAIN] Estado actualizado: ${JSON.stringify(skipUserInputResult.action.payload.updates)}`);
              }
              break;

            case 'END_CALL':
              log("info", `[DOMAIN] Finalizando llamada: ${skipUserInputResult.action.payload.reason || 'COMPLETE'}`);
              // V3-F03: END_CALL Sincrónico
              if (skipUserInputResult.ttsText) {
                const ttsBuffer = await openaiClient.synthesizeSpeech(skipUserInputResult.ttsText);
                if (ttsBuffer) {
                  const rspId = `vb_tts_end_${Date.now()}`;
                  const rawPcmFile = `/tmp/${rspId}.pcm`;
                  const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;
                  fs.writeFileSync(rawPcmFile, ttsBuffer);
                  const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
                  await execAsync(cmd);
                  // Reproducir y ESPERAR a que termine
                  const playback = ari.Playback();
                  await channel.play({ media: `sound:voicebot/${rspId}` }, playback);
                  await new Promise((resolve) => {
                    playback.on('PlaybackFinished', () => resolve());
                    setTimeout(() => resolve(), 6000);
                  });
                }
              }
              // Hangup inmediato tras audio
              log("info", "[ENGINE] Último audio reproducido, colgando canal (V3-F03)");
              conversationState.active = false;
              conversationState.terminated = true; // V3-F04
              try {
                await channel.hangup();
              } catch (e) {
                log("warn", `[ENGINE] Error colgando canal: ${e.message}`);
              }
              break;
          }
        }

        // Reproducir TTS si existe
        if (skipUserInputResult.ttsText) {
          log("info", `🗣️ [ENGINE] Generando TTS para fase sin input: "${skipUserInputResult.ttsText}"`);
          conversationState.history.push({ role: 'assistant', content: skipUserInputResult.ttsText });
          openaiClient.lastAssistantResponse = skipUserInputResult.ttsText;

          const ttsBuffer = await openaiClient.synthesizeSpeech(skipUserInputResult.ttsText);

          if (ttsBuffer) {
            const rspId = `vb_tts_${Date.now()}`;
            const rawPcmFile = `/tmp/${rspId}.pcm`;
            const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

            fs.writeFileSync(rawPcmFile, ttsBuffer);
            const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
            await execAsync(cmd);

            const playback = ari.Playback();
            await channel.play({ media: `sound:voicebot/${rspId}` }, playback);
            await new Promise((resolve) => {
              playback.on('PlaybackFinished', () => resolve());
              setTimeout(() => resolve(), 5000);
            });
          }
        }

        // Auto-avance si hay nextPhase
        if (skipUserInputResult.nextPhase && skipUserInputResult.nextPhase !== businessState.rutPhase) {
          log("info", `🚀 [ENGINE] Auto-avance: ${businessState.rutPhase} → ${skipUserInputResult.nextPhase}`);
          businessState.rutPhase = skipUserInputResult.nextPhase;

          // Continuar el loop inmediatamente para procesar la siguiente fase
          continue;
        }

        // Si no hay nextPhase, continuar normalmente
        continue;
      }
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
    const isCriticalPhase = ['WAIT_BODY', 'CONFIRM', 'ASK_SPECIALTY', 'PARSE_SPECIALTY', 'CONFIRM_APPOINTMENT'].includes(businessState.rutPhase);

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
        audioState.silentTurns++;
        log("warn", `🤫[VB V3] Sin voz detectada(silencio #${audioState.silentTurns})`);

        // ✅ PROMPT "¿SIGUES AHÍ?" DESPUÉS DEL SEGUNDO SILENCIO
        if (audioState.silentTurns === 2) {
          await playStillTherePrompt(ari, channel, openaiClient);
        }

        if (audioState.silentTurns >= MAX_SILENT_TURNS) {
          log("info", "🔚 [VB V3] Demasiados silencios, finalizando sesión");
          conversationState.active = false;
          break;
        }

        continue;
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
        audioState.silentTurns++;

        // 🛡️ MATRIX DE SILENCIO (V3)
        // Regla: En fases críticas, manejar el silencio explícitamente sin fallback OpenAI

        // CASO 1: CONFIRM (Replay en #1, Hangup en #2)
        if (businessState.rutPhase === 'CONFIRM' || businessState.rutPhase === 'CONFIRM_APPOINTMENT') {
          if (audioState.silentTurns === 1) {
            log("info", `🔇 [ENGINE] Silencio #1 en ${businessState.rutPhase}. Re-emitiendo pregunta (Anti-Replay).`);

            // Re-emitir último TTS si existe
            if (conversationState.lastAssistantText) {
              const ttsText = conversationState.lastAssistantText;
              const ttsBuffer = await openaiClient.synthesizeSpeech(ttsText);
              if (ttsBuffer) {
                const rspId = `vb_retry_${Date.now()}`;
                const rawPcmFile = `/tmp/${rspId}.pcm`;
                const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;
                fs.writeFileSync(rawPcmFile, ttsBuffer);
                const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
                await execAsync(cmd);
                // Jugar sin Barge-in para asegurar que escuche la pregunta
                await playWithBargeIn(ari, channel, rspId, openaiClient, { bargeIn: false });
              }
            }
            continue;
          } else {
            log("warn", `🔇 [ENGINE] Silencio #2 en ${businessState.rutPhase}. Finalizando por seguridad (Fail-Closed).`);
            // Reproducir despedida breve antes de cortar? O colgar directo como pide la regla?
            // Regla: "Colgar seguro"
            conversationState.active = false;
            break;
          }
        }

        // ✅ PROMPT "¿SIGUES AHÍ?" PARA OTRAS FASES (WAIT_BODY, etc)
        // Solo si no es fase silenciosa (ya filtrado arriba)
        if (audioState.silentTurns === 2) {
          await playStillTherePrompt(ari, channel, openaiClient, businessState.rutPhase);
        }

        if (audioState.silentTurns >= MAX_SILENT_TURNS) {
          log("info", `🔚[VB V3] Límite de silencios alcanzado, cerrando sesión`);
          conversationState.active = false;
          break;
        }

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
    if (businessState.rutPhase !== 'NONE' && businessState.rutPhase !== 'COMPLETE' && businessState.rutPhase !== 'ERROR') {
      log("info", `🔒 [STRICT MODE] Activo para fase: ${businessState.rutPhase}`);

      // 3.1 Transcripción pura (sin generación de audio por LLM)
      // Si llegamos aquí, el dominio NO indicó skipUserInput, así que transcribimos normalmente
      transcript = await openaiClient.transcribeAudioOnly(userWavPath);
      log("info", `📝 [STRICT MODE] Transcript: "${transcript}"`);

      // 3.2 Lógica de Negocio Determinista (RUT State Machine)
      // Si hay un dominio configurado, delegar al dominio; si no, usar lógica genérica
      let logicResult;

      if (domainContext && domainContext.domain) {
        // 🎯 DELEGAR AL DOMINIO (ej: Quintero con webhooks)
        log("info", `🔀 [ENGINE] Delegando a dominio: ${domainContext.botName || 'unknown'}`);
        const ctx = {
          transcript,
          sessionId: linkedId,
          ani,
          dnis,
          botName: domainContext.botName || 'default', // ✅ CRÍTICO: Pasar botName al dominio
          state: businessState
        };

        log("info", `[DOMAIN] Invocando dominio para fase: ${businessState.rutPhase}, transcript: "${transcript}", botName: ${ctx.botName}`);
        logicResult = await domainContext.domain(ctx);

        // Actualizar businessState con el estado del dominio
        if (ctx.state) {
          Object.assign(businessState, ctx.state);
        }

        log("info", `[DOMAIN] Respuesta del dominio: nextPhase=${logicResult.nextPhase || 'none'}, ttsText=${logicResult.ttsText ? 'presente' : 'ausente'}, action=${logicResult.action ? logicResult.action.type : 'null'}`);

        // 🛡️ GUARDRAIL 1: Validar contrato del dominio en fases críticas
        if (!logicResult.action && (businessState.rutPhase === 'WAIT_BODY' || businessState.rutPhase === 'CONFIRM')) {
          log("warn", `⚠️ [DOMAIN][GUARDRAIL] Dominio ${domainContext.botName || 'unknown'} devolvió action=null en fase crítica: ${businessState.rutPhase}`);
          log("warn", `⚠️ [DOMAIN][GUARDRAIL] Esto puede indicar lógica incompleta en el dominio. Usando fallback seguro.`);
        }

        // 🛡️ GUARDRAIL 2: Bloquear regresiones de fase no válidas
        const PHASE_ORDER = {
          'WAIT_BODY': 1,
          'WAIT_DV': 2,
          'CONFIRM': 3,
          'ASK_SPECIALTY': 4,
          'PARSE_SPECIALTY': 5,
          'CHECK_AVAILABILITY': 6, // ASK_DATE eliminado
          'INFORM_AVAILABILITY': 7,
          'CONFIRM_APPOINTMENT': 8,
          'FINALIZE': 9,
          'COMPLETE': 10
        };

        const currentPhaseOrder = PHASE_ORDER[businessState.rutPhase] || 0;
        const nextPhaseOrder = PHASE_ORDER[logicResult.nextPhase] || 0;

        // Permitir regresiones solo en casos específicos
        const ALLOWED_REGRESSIONS = {
          'CONFIRM': ['WAIT_BODY'], // Usuario rechaza RUT
          'CONFIRM_APPOINTMENT': ['ASK_SPECIALTY'], // Usuario rechaza hora, volver a preguntar especialidad
          'PARSE_SPECIALTY': ['ASK_SPECIALTY'] // Especialidad no identificada
        };

        if (nextPhaseOrder < currentPhaseOrder && logicResult.nextPhase) {
          const allowed = ALLOWED_REGRESSIONS[businessState.rutPhase] || [];
          if (!allowed.includes(logicResult.nextPhase)) {
            log("warn", `⚠️ [DOMAIN][GUARDRAIL] Regresión de fase bloqueada: ${businessState.rutPhase} → ${logicResult.nextPhase}`);
            log("warn", `⚠️ [DOMAIN][GUARDRAIL] Manteniendo fase actual: ${businessState.rutPhase}`);
            logicResult.nextPhase = businessState.rutPhase; // Bloquear regresión
          }
        }

        // 🛡️ GUARDRAIL 3: Validar relevancia semántica del transcript en fases silenciosas
        if (isSilentPhase(businessState.rutPhase) && transcript && transcript.trim().length > 0) {
          log("warn", `⚠️ [DOMAIN][GUARDRAIL] Transcript recibido en fase silenciosa ${businessState.rutPhase}: "${transcript}"`);
          log("warn", `⚠️ [DOMAIN][GUARDRAIL] Ignorando transcript, fase silenciosa no procesa input del usuario`);
          transcript = ""; // Limpiar transcript
        }

        // 🎯 ACTUALIZAR FASE si el dominio indica cambio (se hará después de reproducir TTS si es necesario)

        // 🎯 EJECUTAR ACCIÓN DEL DOMINIO (si existe)
        if (logicResult.action && logicResult.action.type) {
          log("info", `[DOMAIN] Ejecutando acción: ${logicResult.action.type}`);

          switch (logicResult.action.type) {
            case 'USE_ENGINE':
              // Cambiar a engine con query para gestión real
              const { engine, context } = logicResult.action.payload;
              if (engine === 'WITH_QUERY') {
                log("info", `[DOMAIN] Cambiando a engine WITH_QUERY para gestión de negocio`);
                // Importar y usar engine con query
                const { default: startVoiceBotSessionWithQuery } = await import('./voicebot-engine-inbound-withQuery-v0.js');
                // Transferir control al engine con query (pasa contexto si existe)
                await startVoiceBotSessionWithQuery(ari, channel, ani, dnis, linkedId, promptFile);
                // Marcar para finalizar este engine
                return { shouldHangup: true, ttsText: null };
              }
              break;

            case 'CALL_WEBHOOK':
              // El webhook ya fue llamado por el dominio, solo aplicar resultado
              log("info", `[DOMAIN] Webhook ${logicResult.action.payload.name} ya ejecutado por dominio`);
              // Aplicar onSuccess/onError según resultado
              if (logicResult.action.payload.onSuccess) {
                logicResult.nextPhase = logicResult.action.payload.onSuccess.nextPhase || logicResult.nextPhase;
                logicResult.ttsText = logicResult.action.payload.onSuccess.ttsText || logicResult.ttsText;
              }
              break;

            case 'SET_STATE':
              // Actualizar estado con los updates
              if (logicResult.action.payload.updates) {
                Object.assign(businessState, logicResult.action.payload.updates);
                log("info", `[DOMAIN] Estado actualizado: ${JSON.stringify(logicResult.action.payload.updates)}`);
              }
              break;

            case 'END_CALL':
              // Finalizar llamada
              log("info", `[DOMAIN] Finalizando llamada: ${logicResult.action.payload.reason || 'COMPLETE'}`);
              return {
                ttsText: logicResult.action.payload.ttsText || logicResult.ttsText,
                nextPhase: 'COMPLETE',
                shouldHangup: true
              };

            default:
              log("warn", `[DOMAIN] Acción desconocida: ${logicResult.action.type}`);
          }
        }
      } else {
        // Lógica genérica (sin dominio)
        log("debug", `[ENGINE] Usando lógica genérica (sin dominio) para fase: ${businessState.rutPhase}`);
        logicResult = await handleRutState(transcript, businessState, linkedId);
      }

      // Actualizar Transcripts Logs
      conversationState.history.push({ role: 'user', content: transcript || '[Silencio/No entendido]' });

      // 3.3 Generación de Audio Explícito (TTS)
      if (logicResult.ttsText) {
        // 🛡️ GUARDRAIL: Anti-Replay (Evitar doble TTS)
        if (conversationState.lastAssistantText === logicResult.ttsText) {
          log("warn", `🔇 [STRICT MODE] TTS duplicado detectado, omitiendo reproducción: "${logicResult.ttsText.slice(0, 30)}..."`);
        } else {
          log("info", `🗣️ [STRICT MODE] Generando TTS para: "${logicResult.ttsText}"`);
          conversationState.history.push({ role: 'assistant', content: logicResult.ttsText });
          openaiClient.lastAssistantResponse = logicResult.ttsText; // Para logs
          conversationState.lastAssistantText = logicResult.ttsText; // 🛡️ Actualizar estado para anti-replay

          const ttsBuffer = await openaiClient.synthesizeSpeech(logicResult.ttsText);

          if (ttsBuffer) {
            const rspId = `vb_tts_${Date.now()}`;
            const rawPcmFile = `/tmp/${rspId}.pcm`;
            const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

            fs.writeFileSync(rawPcmFile, ttsBuffer);

            // Convertir para Asterisk (seguro es PCM s16le 24k -> wav 8k)
            const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
            await execAsync(cmd);

            responseBaseName = rspId;

            // Reproducir TTS
            const playback = ari.Playback();
            await channel.play({ media: `sound:voicebot/${rspId}` }, playback);

            // Esperar a que termine la reproducción
            await new Promise((resolve) => {
              playback.on('PlaybackFinished', () => resolve());
              setTimeout(() => resolve(), 5000); // Timeout de seguridad
            });
          }
        }
      }

      // Nota: El auto-avance se maneja al inicio del turno cuando el dominio devuelve skipUserInput
      // Si llegamos aquí, el dominio NO indicó skipUserInput, así que procesamos normalmente

      // Si la lógica decidió finalizar (ej. Error loop)
      if (logicResult.shouldHangup) {
        conversationState.active = false;
      }

      // 🛑 FIX: Evitar fall-through a la sección de playback genérico
      // El modo estricto maneja su propio playback internamente.
      continue;

    }
    // --- MODO NORMAL (Conversacional) ---
    else {
      // 🛡️ GUARDRAIL Fix Problem D: Evitar fallback alucinatorio si perdimos identidad
      if (businessState.rutPhase === 'COMPLETE' && !businessState.rutFormatted) {
        log("warn", "[ENGINE] Fallback bloqueado: sesión COMPLETE sin RUT válido. Terminando.");
        conversationState.active = false;
        break;
      }

      // 🛡️ GUARDRAIL: Anti-Fallback Global (V3-Safe) - Regla 2.3 User Rule
      // Bloquear fallback OpenAI si estamos en una sesión avanzada pero sin RUT validado
      if (turn > 1 && !businessState.rutFormatted && businessState.rutPhase !== 'WAIT_BODY') {
        log("warn", "[ENGINE] Fallback bloqueado: sesión sin identidad en turno avanzado. Terminando para evitar alucinación.");
        conversationState.active = false;
        break;
      }

      // 3.1 Procesar con OpenAI Realtime (Audio-to-Audio)
      responseBaseName = await processUserTurnWithOpenAI(userWavPath, openaiClient);

      if (!conversationState.active) {
        log("info", `🔚[VB V3] Sesión terminada durante OpenAI`);
        break;
      }

      if (!responseBaseName) {
        // Fallback o reintento si OpenAI falla
        log("warn", `⚠️[VB V3] Sin respuesta OpenAI en modo normal`);
      }

      // 3.2 Obtener transcript (async)
      transcript = await waitForTranscript(openaiClient);

      // Fallback Whisper para logs
      const audioStats = fs.statSync(userWavPath);
      if ((!transcript || transcript.trim().length === 0) && audioStats.size > 8000) {
        transcript = await openaiClient.transcribeAudioWithWhisper(userWavPath);
      }

      conversationState.history.push({ role: 'user', content: transcript || '[...]' });
      if (openaiClient.lastAssistantResponse) {
        conversationState.history.push({ role: 'assistant', content: openaiClient.lastAssistantResponse });
      }

      // --- POST-PROCESSING LÓGICO ---
      // Aquí verificamos si apareció un RUT de la nada, o intentamos agendar/transferir
      // Si detectamos intención de dar RUT, forzamos entrada a Strict Mode para el sgte turno
      // Ojo: Si ya estábamos en COMPLETE, quizá validamos datos.

      // LOGICA DE AGENDA / TRANSFERENCIA (Mantener la existente)
      // ... (Tu código existente de agenda/transfer se invocaría aquí si no entramos en Strict Mode)
      // Por simplicidad, adaptaremos la lógica existente para correr DESPUÉS de tener transcript.

      await runBusinessLogic(transcript, openaiClient.lastAssistantResponse, businessState, conversationState, ari, channel, openaiClient, linkedId);
    }


    /*
    // =======================================================
    // 3) Procesar con OpenAI
    // =======================================================
    const responseBaseName = await processUserTurnWithOpenAI(userWavPath, openaiClient);
 
    if (!conversationState.active) {
      log("info", `🔚[VB V3] Sesión terminada durante OpenAI`);
      break;
    }
 
    // ---------------------------------------------------------
    // Procesar respuesta y transcripción
    // ---------------------------------------------------------
    if (!responseBaseName) {
      log("warn", `⚠️[VB V3] Sin respuesta OpenAI, finalizando`);
      break;
    }
 
    // ESPERAR TRANSCRIPCIÓN (OpenAI Realtime es asíncrono)
    let transcript = await waitForTranscript(openaiClient);
 
    // FALLBACK WHISPER (Solo si el audio es mayor a 8KB para evitar basura Amara.org)
    const audioStats = fs.statSync(userWavPath);
    if ((!transcript || transcript.trim().length === 0) && audioStats.size > 8000) {
      log("info", `🔄 [FALLBACK] Realtime sin transcript. Intentando Whisper estático (${audioStats.size} bytes)...`);
      transcript = await openaiClient.transcribeAudioWithWhisper(userWavPath);
      if (transcript) {
        log("info", `🎯 [FALLBACK] Whisper recuperó: "${transcript}"`);
      }
    }
 
    // Acumular transcripciones para el registro final (Capa B: Log de Conversación)
    const userTranscriptForLog = transcript || '[Audio sin transcripción o muy corto]';
    conversationState.history.push({ role: 'user', content: userTranscriptForLog });
 
    if (openaiClient.lastAssistantResponse) {
      conversationState.history.push({ role: 'assistant', content: openaiClient.lastAssistantResponse });
    }
 
    // ---------------------------------------------------------
    // Lógica de turno (RUT, Especialidad, Clasificación)
    // ---------------------------------------------------------
    try {
      assistantResponse = openaiClient.lastAssistantResponse || '';
 
      // Anti-loop safeguard
      if (assistantResponse === conversationState.lastAssistantText && assistantResponse.length > 0) {
        conversationState.repeatedCount++;
      } else {
        conversationState.repeatedCount = 0;
      }
      conversationState.lastAssistantText = assistantResponse;
 
      if (conversationState.repeatedCount >= 3) {
        log("info", `🔁 [ANTI-LOOP] Transferencia por loop (#${conversationState.repeatedCount})`);
        await sendSystemTextAndPlay(ari, channel, openaiClient, "Disculpe, parece que tenemos problemas técnicos para avanzar. Le comunico con un ejecutivo.");
        await transferToQueue(ari, channel, QUEUES_NAME || "cola_ventas");
        conversationState.active = false;
        break;
      }
 
      // 1. Detección de RUT Estricta (Hardening IVR)
      if (transcript) {
        const candidate = extractRutCandidate(transcript);
        const allDigits = candidate.allDigits || "";
 
        // FASE A: Captura de CUERPO
        if (!businessState.rutBody) {
          if (candidate.body) {
            // Regla de Oro: En FASE A, ignoramos el DV aunque venga en el transcript, 
            // para forzar al usuario a confirmarlo en el siguiente turno.
            businessState.rutBody = candidate.body;
            log('info', `📄 [RUT] Cuerpo capturado: ${candidate.body} (FASE 1 exitosa. DV ignorado si existía)`);
 
            // Forzamos al LLM a pedir el DV enviándole una instrucción de "cuerpo recibido"
            await openaiClient.sendSystemText(`CUERPO RECIBIDO: ${candidate.body}. AHORA PIDE EL DÍGITO VERIFICADOR.`);
          } else if (candidate.dv && allDigits.length < 7) {
            log('warn', `⚠️ [RUT] Usuario entregó DV o número corto cuando se esperaba cuerpo.`);
          }
        }
        // FASE B: Captura de DV (Solo si ya tenemos el cuerpo)
        else if (businessState.rutBody && !businessState.dni) {
          if (candidate.dv) {
            businessState.rutDv = candidate.dv;
            log('info', `📄 [RUT] DV capturado: ${candidate.dv} (FASE 2 exitosa)`);
          } else if (candidate.body && candidate.body !== businessState.rutBody) {
            log('info', `📄 [RUT] Usuario actualizó cuerpo: ${candidate.body}`);
            businessState.rutBody = candidate.body;
          }
        }
 
        // FASE C: Validación y Búsqueda (Solo cuando el ciclo esté completo)
        if (businessState.rutBody && businessState.rutDv && !businessState.dni) {
          const fullRut = `${businessState.rutBody}${businessState.rutDv}`;
          const normalized = normalizeRut(fullRut);
 
          if (isValidRut(normalized)) {
            log('info', `✅ [RUT] Ciclo completo y Válido: ${maskRut(normalized)}`);
            businessState.dni = normalized;
            businessState.rutAttempts = 0;
 
            // Búsqueda en DB (Mensaje BVDA - Protegido)
            const patient = await getPatientByRut(normalized);
            if (patient) {
              businessState.patient = patient;
              log('info', `👤 [DB] Paciente encontrado: ${patient.nombre_completo}`);
              await sendBvdaText(ari, channel, openaiClient, `PACIENTE ENCONTRADO EN SQL: ${patient.nombre_completo}. Edad: ${patient.edad || 'desconocida'}. ${patient.observacion ? 'Observación: ' + patient.observacion : ''}. Pregunta al usuario cómo puedes ayudarle.`);
            } else {
              log('warn', `⚠️ [DB] RUT ${maskRut(normalized)} no existe en base de datos`);
              await sendBvdaText(ari, channel, openaiClient, `PACIENTE NO ENCONTRADO para el RUT ${maskRut(normalized)}. Informa al usuario que no figura en el sistema y ofrece derivar a ejecutivo.`);
            }
          } else {
            log('warn', `⚠️ [RUT] Validación fallida (DV incorrecto): ${businessState.rutBody}-${businessState.rutDv}`);
            businessState.rutAttempts++;
            // Limpiamos DV para re-intentar solo esa parte o todo según el prompt
            businessState.rutDv = null;
          }
        } else if (!candidate.body && !candidate.dv && transcript.length > 5) {
          if (!/hola|alo|bueno|si|no/i.test(transcript)) {
            businessState.rutAttempts++;
            log('info', `⚠️ [RUT] Sin datos útiles. Intento #${businessState.rutAttempts}/5`);
          }
        }
      }
 
      // 2. Detección de Especialidad con SOFT-LOCK (HOLD)
      const detectedSpecialty = detectSpecialty(transcript);
      if (detectedSpecialty && !businessState.heldSlot) {
        log('info', `🎯 [AGENDA] Especialidad detectada: ${detectedSpecialty}. Intentando HOLD...`);
        const slot = await getAndHoldNextSlot(detectedSpecialty, linkedId);
        if (slot) {
          businessState.heldSlot = slot;
          businessState.specialty = detectedSpecialty;
          log('info', `✅ [AGENDA] Cupo en HOLD: ${slot.id_disponibilidad} para ${slot.fecha} ${slot.hora_disponible}`);
 
          const slotTime = slot.hora_disponible ? slot.hora_disponible.toString().slice(0, 5) : '';
          const slotDate = slot.fecha ? new Date(slot.fecha).toLocaleDateString('es-CL') : '';
 
          await openaiClient.sendSystemText(`CUPO RESERVADO TEMPORALMENTE: Especialidad ${detectedSpecialty}, Fecha ${slotDate}, Hora ${slotTime}. PREGUNTA AL USUARIO SI DESEA CONFIRMAR ESTA HORA.`);
        } else {
          log('warn', `⚠️ [AGENDA] No hay cupos disponibles para ${detectedSpecialty}`);
          await openaiClient.sendSystemText(`SIN DISPONIBILIDAD para ${detectedSpecialty}. Informa al usuario y ofrece derivar a ejecutivo.`);
        }
      }
 
      // 3. Confirmación de Cita (Promoción de HOLD a OCUPADO)
      if (businessState.heldSlot && assistantResponse.toLowerCase().includes("reservar") && (transcript.toLowerCase().includes("sí") || transcript.toLowerCase().includes("acepto") || transcript.toLowerCase().includes("confirmar"))) {
        log('info', `🎯 [AGENDA] Usuario confirma cita. Procesando agendamiento real...`);
 
        const slot = businessState.heldSlot;
        const appointmentDate = new Date(slot.fecha);
        if (slot.hora_disponible instanceof Date) {
          appointmentDate.setHours(slot.hora_disponible.getHours(), slot.hora_disponible.getMinutes(), 0, 0);
        }
 
        const result = await scheduleAppointment(
          businessState.dni,
          appointmentDate,
          businessState.specialty,
          'voicebot_quintero',
          linkedId
        );
 
        if (result.ok) {
          log('info', `✅ [AGENDA] Cita agendada exitosamente: ID ${result.id}`);
          await openaiClient.sendSystemText(`CITA CONFIRMADA EXITOSAMENTE. ID de reserva: ${result.id}. Felicita al usuario y despídete.`);
          businessState.heldSlot = null; // Limpiar para evitar dobles
        } else {
          log('error', `❌ [AGENDA] Error al agendar: ${result.error}`);
          await openaiClient.sendSystemText(`ERROR AL AGENDAR: No se pudo confirmar la hora en el sistema. Deriva a un ejecutivo.`);
        }
      }
 
      if (businessState.rutAttempts >= 5) {
        await sendSystemTextAndPlay(ari, channel, openaiClient, "No logro capturar su RUT. Le transferiré con un ejecutivo.");
        await transferToQueue(ari, channel, QUEUES_NAME || "cola_ventas");
        conversationState.active = false;
        break;
      }
 
    } catch (err) {
      log('warn', `⚠️ [TURNO] Error en lógica de negocio: ${err.message}`);
    }
    */

    // ---------------------------------------------------------
    // Verificar si se debe transferir a cola por semántica
    // ---------------------------------------------------------
    const shouldTransfer = shouldTransferToQueue(transcript, openaiClient.lastAssistantResponse);
    if (shouldTransfer) {
      log("info", `📞[VB V3] Transferencia semántica detectada`);
      const transferred = await transferToQueue(ari, channel, QUEUES_NAME || "cola_ventas");
      if (transferred) {
        conversationState.active = false;
        break;
      }
    }
    // =======================================================
    // 5) Reproducir respuesta con barge-in (Controlado por BVDA)
    // =======================================================
    // Regla IVR: No permitir interrupciones si el mensaje contiene un RUT o es una confirmación crítica
    // En Strict Mode, assistantResponse puede estar vacío, usar lastAssistantResponse como fallback
    const responseText = assistantResponse || openaiClient.lastAssistantResponse || '';
    const isCriticalResponse = /rut|confirmar|registrado|encontrado|id de reserva/i.test(responseText);
    // 🛡️ Deshabilitar barge-in si el bot lo requiere (ej: Quintero para adultos mayores)
    const allowBargeIn = !isCriticalResponse && !businessState.disableBargeIn;

    if (isCriticalResponse) {
      log("info", `🛡️ [BVDA] Detectada respuesta crítica del asistente, desactivando barge-in.`);
    }
    if (businessState.disableBargeIn) {
      log("info", `🛡️ [BVDA] Barge-in deshabilitado por configuración del bot (adultos mayores).`);
    }

    let playbackResult = { reason: 'skipped_no_audio' };

    if (responseBaseName) {
      playbackResult = await playWithBargeIn(ari, channel, responseBaseName, openaiClient, { bargeIn: allowBargeIn });
    } else {
      log("debug", "🔇 [VB V3] Playback omitido en este turno (responseBaseName null/empty)");
    }

    if (!conversationState.active) {
      log("info", `🔚[VB V3] Sesión terminada durante playback`);
      break;
    }

    if (playbackResult.reason === "failed" || playbackResult.reason === "error") {
      log("warn", `⚠️[VB V3] Playback error(${playbackResult.reason}), finalizando`);
      break;
    }

    // prompt "¿COMPRENDO?" removed for better UX

    // ✅ SEGURIDAD IVR: Pequeña pausa tras playback antes de abrir micrófono (evitar eco/barge-in accidental)
    if (!allowBargeIn) {
      log("debug", "⏱️ [ORCHESTRATION] Aplicando pausa de seguridad tras audio crítico del asistente");
      await new Promise(r => setTimeout(r, 600));
    } else {
      await new Promise(r => setTimeout(r, 200)); // Delay mínimo para audios normales
    }

    // ✅ DETECTAR DESPEDIDA Y COLGAR
    assistantResponse = openaiClient.lastAssistantResponse || "";
    if (shouldEndCall(assistantResponse)) {
      log("info", `🔚 [VB V3] Despedida detectada ("${assistantResponse}") → Colgando canal.`);
      // Esperar un momento para que el audio termine de reproducirse en el canal si el playback terminó
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        await channel.hangup();
      } catch (err) {
        log("warn", `⚠️ Error colgando tras despedida: ${err.message}`);
      }
      conversationState.active = false;
      break;
    }
  }

  openaiClient.disconnect();
  log("info", `🔚[VB ENGINE V3] Sesión finalizada LinkedId = ${linkedId} (turnos exitosos: ${audioState.successfulTurns})`);

  // Finalizar almacenamiento e inicio de registro SQL (async)
  finalizeCallStorage(ari, channel, ani, dnis, linkedId, conversationState, audioState, businessState).catch(err => {
    log("error", `❌ [FINALIZE] Error fatal en finalización: ${err.message}`);
  });
}

/**
 * Espera a que la transcripción de OpenAI Realtime esté disponible.
 */
async function waitForTranscript(client, timeoutMs = 2500) {
  const start = Date.now();
  // Limpiar el transcript anterior antes de esperar el nuevo del turno
  // Nota: Esto depende de si el cliente limpia lastTranscript entre turnos o no.
  // En este motor, el loop es bloqueante por cada turno de voz.

  while (Date.now() - start < timeoutMs) {
    if (client.lastTranscript) return client.lastTranscript;
    await new Promise(r => setTimeout(r, 100)); // Polling más rápido (100ms)
  }
  return client.lastTranscript || "";
}

/**
 * Guarda la grabación, el log de conversación y el registro en SQL Server al final de la llamada.
 */
async function finalizeCallStorage(ari, channel, ani, dnis, linkedId, conv, audio, biz) {
  try {
    const endTime = new Date();
    const duration = Math.round((endTime - conv.startTime) / 1000);

    // Generar texto del log de conversación
    const transcriptText = conv.history
      .map(entry => entry.role === 'user' ? `👤 Usuario: ${entry.content}` : `🤖 Asistente: ${entry.content}`)
      .join('\n');

    // 1. Preparar nombres y carpetas
    // Formato solicitado: IdentificadorUnicoDeLlamada_DNI_ANI_unixtime.wav
    const unixTime = Math.floor(conv.startTime.getTime() / 1000);
    const safeDni = biz.dni ? biz.dni.replace(/[^0-9Kk]/g, '') : 'UNKNOWN';
    const finalFileName = `${linkedId}_${safeDni}_${ani}_${unixTime}`;

    const now = new Date();
    const yyyymmdd = now.toISOString().split('T')[0].replace(/-/g, '');
    const finalDir = `/opt/telephony-core/recordings/${dnis}/${yyyymmdd}`;

    log("info", `📂 [FINALIZE] Preparando almacenamiento en ${finalDir}`);

    if (!fs.existsSync(finalDir)) {
      fs.mkdirSync(finalDir, { recursive: true });
    }

    const finalWavPath = path.join(finalDir, `${finalFileName}.wav`);
    const finalTxtPath = path.join(finalDir, `${finalFileName}_conversation_log.txt`);

    // 2. Guardar log de conversación (Capa B)
    fs.writeFileSync(finalTxtPath, transcriptText);
    log("info", `📄 [FINALIZE] Log de conversación guardado: ${finalTxtPath}`);

    // 3. Mover/Copiar grabación MASTER (MixMonitor)
    // MixMonitor genera el archivo en /var/spool/asterisk/monitor/voicebot/YYYYMMDD/...
    const mixName = `${linkedId}_${ani}_${dnis}_mix.wav`;
    const mixPath = path.join(`/var/spool/asterisk/monitor/voicebot/${yyyymmdd}`, mixName);

    // Esperar unos segundos para asegurar que MixMonitor cerró el archivo
    setTimeout(async () => {
      log("info", `🔍 [FINALIZE] Buscando grabación master (MixMonitor) en: ${mixPath}`);
      if (fs.existsSync(mixPath)) {
        try {
          fs.copyFileSync(mixPath, finalWavPath);
          log("info", `🎙️ [FINALIZE] Grabación master copiada a ruta final: ${finalWavPath}`);
        } catch (copyErr) {
          log("error", `❌ [FINALIZE] Error copiando archivo master: ${copyErr.message}`);
        }
      } else {
        log("warn", `⚠️ [FINALIZE] No se encontró el archivo master ${mixPath}`);

        // Fallback: buscar grabación ARI antigua por si acaso
        const originalName = `${linkedId}_${ani}_${dnis}`.replace(/[^0-9A-Za-z_+]/g, "_");
        const originalPath = path.join(config.paths.recordings || '/var/spool/asterisk/recording', `${originalName}.wav`);

        if (fs.existsSync(originalPath)) {
          log("info", `🔄 [FINALIZE] Fallback a grabación ARI: ${originalPath}`);
          try {
            fs.copyFileSync(originalPath, finalWavPath);
          } catch (e) { }
        }
      }
    }, 5000);

    // 4. Registro en SQL Server
    try {
      log("info", `🗄️ [FINALIZE] Registrando gestión en SQL Server...`);
      const pool = await poolPromise;
      if (pool) {
        await pool.request()
          .input('FechaHoraInicio', sql.DateTime, conv.startTime)
          .input('FechaHoraTermino', sql.DateTime, endTime)
          .input('Agente', sql.NVarChar, 'VoiceBot')
          .input('ANI', sql.NVarChar, ani)
          .input('DNIS', sql.NVarChar, dnis)
          .input('Identificador', sql.NVarChar, linkedId)
          .input('DNI_Capturado', sql.NVarChar, biz.dni || 'UNKNOWN')
          .input('Transcripcion', sql.NVarChar, transcriptText)
          .input('RutaGrabacion', sql.NVarChar, finalWavPath)
          .input('DuracionSegundos', sql.Int, duration)
          .input('HasUserSpeech', sql.Bit, audio.hasSpeech ? 1 : 0)
          .input('TurnsCount', sql.Int, audio.successfulTurns || 0)
          .execute('sp_GuardarGestionLlamada');

        log("info", `✅ [SQL] Gestión guardada exitosamente para ${linkedId}`);
      } else {
        log("error", `❌ [SQL] No hay pool de conexión disponible`);
      }
    } catch (sqlErr) {
      log("error", `❌ [SQL] Error ejecutando SP: ${sqlErr.message}`);
    }

  } catch (err) {
    log("error", `❌ [FINALIZE] Error en proceso de finalización: ${err.message}`);
  }
}

/**
 * 🧱 HARD STATE MACHINE: Lógica determinista para RUT
 * Decide qué texto decir (TTS) y cómo cambiar de estado.
 */

// --- Helper Functions de Negocio ---
function getMaskedRutReading(body, dv) {
  if (!body) return "desconocido";
  const last3 = body.toString().slice(-3);
  // Mapeo básico de dígitos a texto si se desea, o dejar que el TTS lo lea
  // TTS lee bien "dos cinco ocho".

  // Convertir "123" a "uno dos tres" para asegurar lectura dígito a dígito (opcional, pero recomendado para claridad)
  const digitMap = {
    '0': 'cero', '1': 'uno', '2': 'dos', '3': 'tres', '4': 'cuatro',
    '5': 'cinco', '6': 'seis', '7': 'siete', '8': 'ocho', '9': 'nueve', 'k': 'ka', 'K': 'ka'
  };

  const readDigits = (str) => str.split('').map(c => digitMap[c] || c).join(' ');

  return `${readDigits(last3)} guión ${digitMap[dv.toString().toLowerCase()] || dv}`;
}

async function handleRutState(transcript, businessState, linkedId) {
  const result = {
    ttsText: null,
    shouldHangup: false
  };

  const cleanTranscript = (transcript || "").toLowerCase();

  log("debug", `⚙️ [RUT LOGIC] Phase=${businessState.rutPhase} Input="${cleanTranscript}"`);

  switch (businessState.rutPhase) {

    // --- FASE 1: Esperando RUT COMPLETO (12345678-9) ---
    case 'WAIT_BODY':
    case 'WAIT_RUT':
      // 🎯 CAPA 1: Regex fuerte PRIMERO (early exit si es válido)
      const hardRut = extractRutHard(transcript);

      if (hardRut && isValidRut(hardRut)) {
        // ✅ RUT válido capturado por regex → SALIDA INMEDIATA
        const normalized = normalizeRut(hardRut);
        const body = normalized.slice(0, -1);
        const dv = normalized.slice(-1);

        businessState.rutBody = body;
        businessState.rutDv = dv;
        businessState.rutPhase = 'CONFIRM';
        businessState.rutAttempts = 0;
        businessState.confirmAttempts = 0;

        const maskedReading = getMaskedRutReading(body, dv);
        result.ttsText = `Tengo registrado el RUT terminado en ${maskedReading}. ¿Es correcto?`;
        log("info", `✅ [STATE] RUT capturado por regex duro: ${normalized} (Input: "${transcript}")`);
        break;
      }

      // 🎯 CAPA 2: Parser mejorado con normalización y regex robusto
      const parsed = parseRutFromSpeech(cleanTranscript);

      log("debug", `⚙️ [RUT PARSER] reason=${parsed.reason} body=${parsed.body} dv=${parsed.dv} ok=${parsed.ok}`);

      // Si detectamos BODY + DV juntos → saltar directamente a CONFIRM
      if (parsed.body && parsed.dv) {
        const bodyStr = String(parsed.body);
        const isValid = isValidRut(normalizeRut(`${bodyStr}${parsed.dv}`));

        businessState.rutBody = bodyStr;
        businessState.rutDv = parsed.dv;
        businessState.rutPhase = 'CONFIRM';
        businessState.rutAttempts = 0;
        businessState.confirmAttempts = 0;

        const maskedReading = getMaskedRutReading(bodyStr, parsed.dv);
        result.ttsText = isValid
          ? `Tengo registrado el RUT terminado en ${maskedReading}. ¿Es correcto?`
          : `Escuché el RUT terminado en ${maskedReading}. ¿Es correcto?`;

        log("info", `✅ [STATE] BODY+DV capturados juntos: Body=${bodyStr} DV=${parsed.dv} (Input: "${transcript}")`);
        break;
      }

      // Si solo tenemos BODY → pasar a WAIT_DV
      if (parsed.body && !parsed.dv) {
        const bodyStr = String(parsed.body);
        businessState.rutBody = bodyStr;
        businessState.rutPhase = 'WAIT_DV';
        businessState.rutAttempts++;
        log("info", `📝 [STATE] Body capturado: ${bodyStr}. Esperando DV. Intento #${businessState.rutAttempts}`);
        result.ttsText = "Me faltó el dígito verificador. Por favor dígame solo el dígito verificador, por ejemplo: guión ocho, o guión k.";
        break;
      }

      // No se entendió nada → incrementar intentos
      businessState.rutAttempts++;
      log("warn", `⚠️ [STATE] No entendí RUT. Intento #${businessState.rutAttempts}`);

      if (businessState.rutAttempts >= 3) {
        businessState.rutPhase = 'FAILED';
        result.ttsText = "No logro capturar su RUT. Le transferiré con un ejecutivo.";
        result.shouldHangup = true;
      } else {
        result.ttsText = "Por favor, indíqueme su RUT completo, incluyendo el dígito verificador.";
      }
      break;

    // --- FASE 2: Esperando solo DV ---
    case 'WAIT_DV':
      // Limpiar ruido social primero (BUENAS NOCHES, etc.)
      const cleanedDV = cleanAsrNoise(transcript);

      // Si después de limpiar solo queda ruido, ignorar y seguir pidiendo
      if (!cleanedDV || cleanedDV.trim().length === 0 || /^(Y|Y\s+BUENAS|BUENAS|NOCHE|HOLA)$/i.test(cleanedDV.trim())) {
        businessState.rutAttempts++;
        log("info", `🔇 [STATE] Ruido social ignorado en WAIT_DV: "${transcript}". Intento #${businessState.rutAttempts}`);

        if (businessState.rutAttempts >= 3) {
          businessState.rutPhase = 'FAILED';
          result.ttsText = "No logro capturar el dígito verificador. Le transferiré con un ejecutivo.";
          result.shouldHangup = true;
        } else {
          result.ttsText = "Solo necesito el dígito verificador, por ejemplo: ocho o K.";
        }
        break;
      }

      // Intentar extraer DV con regex primero
      const dvMatch = cleanedDV.match(/([0-9K])/);
      if (dvMatch) {
        const dv = dvMatch[1].toUpperCase();
        businessState.rutDv = dv;
        const rawRut = `${businessState.rutBody}-${dv}`;
        const normalized = normalizeRut(rawRut);

        if (isValidRut(normalized)) {
          businessState.rutPhase = 'CONFIRM';
          businessState.rutAttempts = 0;
          businessState.confirmAttempts = 0; // Inicializar contador de confirmación
          const maskedReading = getMaskedRutReading(businessState.rutBody, dv);
          result.ttsText = `Tengo registrado el RUT terminado en ${maskedReading}. ¿Es correcto?`;
          log("info", `✅ [STATE] WAIT_DV -> CONFIRM (RUT=${normalized})`);
          break;
        } else {
          // ✅ CONFIRMACIÓN INTELIGENTE: Si el DV no calza, confirmar en lugar de rechazar
          businessState.rutPhase = 'CONFIRM';
          businessState.rutAttempts = 0;
          businessState.confirmAttempts = 0; // Inicializar contador de confirmación
          const maskedReading = getMaskedRutReading(businessState.rutBody, dv);
          result.ttsText = `Escuché el RUT terminado en ${maskedReading}. ¿Es correcto?`;
          log("warn", `⚠️ [STATE] DV no calza matemáticamente pero pedimos confirmación. Body=${businessState.rutBody} DV=${dv}`);
          break;
        }
      }

      // Si regex falló, intentar NLP semántico
      const parsedDV = parseRutFromSpeech(cleanTranscript);

      if (parsedDV.dv) {
        // DV capturado
        businessState.rutDv = parsedDV.dv;
        const rawRut = `${businessState.rutBody}-${businessState.rutDv}`;
        const normalized = normalizeRut(rawRut);

        if (isValidRut(normalized)) {
          businessState.rutPhase = 'CONFIRM';
          businessState.rutAttempts = 0;
          businessState.confirmAttempts = 0; // Inicializar contador de confirmación
          const maskedReading = getMaskedRutReading(businessState.rutBody, businessState.rutDv);
          result.ttsText = `Tengo registrado el RUT terminado en ${maskedReading}. ¿Es correcto?`;
          log("info", `✅ [STATE] WAIT_DV -> CONFIRM (RUT=${normalized})`);
        } else {
          // ✅ CONFIRMACIÓN INTELIGENTE: Si el DV no calza, confirmar en lugar de rechazar
          businessState.rutPhase = 'CONFIRM';
          businessState.rutAttempts = 0;
          businessState.confirmAttempts = 0; // Inicializar contador de confirmación
          const maskedReading = getMaskedRutReading(businessState.rutBody, businessState.rutDv);
          result.ttsText = `Escuché el RUT terminado en ${maskedReading}. ¿Es correcto?`;
          log("warn", `⚠️ [STATE] DV no calza matemáticamente pero pedimos confirmación. Body=${businessState.rutBody} DV=${businessState.rutDv}`);
        }
      } else {
        businessState.rutAttempts++;
        log("warn", `⚠️ [STATE] No se capturó DV. Intento #${businessState.rutAttempts}`);

        if (businessState.rutAttempts >= 3) {
          businessState.rutPhase = 'FAILED';
          result.ttsText = "No logro capturar el dígito verificador. Le transferiré con un ejecutivo.";
          result.shouldHangup = true;
        } else {
          result.ttsText = "Por favor dígame solo el dígito verificador, por ejemplo: guión ocho, o guión k.";
        }
      }
      break;

    // --- FASE 2: Confirmación (Sí/No) con CLASIFICADOR ROBUSTO ---
    case 'CONFIRM':
      // Inicializar contador de confirmación si no existe
      if (businessState.confirmAttempts === undefined) {
        businessState.confirmAttempts = 0;
      }
      businessState.confirmAttempts++;

      // 0. Verificar si el usuario corrigió solo el DV (mantiene body, cambia DV)
      const parsedCorrection = parseRutFromSpeech(cleanTranscript);
      if (parsedCorrection.dv && parsedCorrection.dv !== businessState.rutDv &&
        (!parsedCorrection.body || parsedCorrection.body === businessState.rutBody)) {
        // Usuario corrigió solo el DV
        log("info", `🔄 [STATE] Usuario corrigió DV: ${businessState.rutDv} -> ${parsedCorrection.dv}`);
        businessState.rutDv = parsedCorrection.dv;
        businessState.confirmAttempts = 0; // Reset contador al corregir
        const rawRutCorrected = `${businessState.rutBody}-${businessState.rutDv}`;
        const normalizedCorrected = normalizeRut(rawRutCorrected);

        if (isValidRut(normalizedCorrected)) {
          const maskedReading = getMaskedRutReading(businessState.rutBody, businessState.rutDv);
          result.ttsText = `Perfecto. Tengo el RUT terminado en ${maskedReading}. ¿Es correcto?`;
          log("info", `✅ [STATE] DV corregido y válido. RUT=${normalizedCorrected}`);
        } else {
          businessState.rutAttempts++;
          log("warn", `⚠️ [STATE] DV corregido pero inválido. Intento #${businessState.rutAttempts}`);
          if (businessState.rutAttempts >= 3) {
            businessState.rutPhase = 'FAILED';
            result.ttsText = "El dígito verificador no es válido. Le transferiré con un ejecutivo.";
            result.shouldHangup = true;
          } else {
            result.ttsText = "El dígito verificador que escuché no es válido. Por favor dígalo nuevamente.";
          }
        }
        break;
      }

      // 1. Clasificador robusto SIN LLM (diccionario simple)
      const confirmIntent = classifyConfirmSimple(cleanTranscript);
      log("info", `🔍 [CONFIRM] Intento #${businessState.confirmAttempts}, Intent="${confirmIntent}", Transcript="${cleanTranscript}"`);

      if (confirmIntent === 'YES') {
        // LÓGICA DE ÉXITO -> COMPLETE
        const fullRutRaw = `${businessState.rutBody}-${businessState.rutDv}`;
        const normalized = normalizeRut(fullRutRaw);
        businessState.dni = normalized;
        businessState.rutPhase = 'COMPLETE';

        log("info", `✅ [STATE] CONFIRM(YES) -> COMPLETE (RUT Validado: ${normalized})`);

        // Búsqueda en DB
        let patient = await getPatientByRut(normalized);

        // Fallback: Intentar con formato 12.345.678-9
        if (!patient) {
          const formattedForDb = formatRut(normalized);
          patient = await getPatientByRut(formattedForDb);
        }

        if (patient) {
          businessState.patient = patient;
          result.ttsText = `Gracias. He validado sus datos y lo encontré en el sistema como ${patient.nombre_completo}. ¿En qué puedo ayudarle?`;
        } else {
          result.ttsText = `RUT correctamente validado. No tengo datos previos suyos en el sistema, pero puedo ayudarle. ¿Qué necesita?`;
        }
      }
      else if (confirmIntent === 'NO') {
        // LÓGICA DE RECHAZO -> RESET (WAIT_RUT)
        log("info", `🔄 [STATE] CONFIRM(NO) -> WAIT_RUT`);
        businessState.rutPhase = 'WAIT_BODY'; // alias WAIT_RUT
        businessState.rutBody = null;
        businessState.rutDv = null;
        businessState.rutAttempts = 0;
        result.ttsText = "Entendido. Inténtémoslo de nuevo. Por favor dígame su RUT completo.";
      }
      else {
        // UNKNOWN -> ACEPTACIÓN IMPLÍCITA después de 2 intentos (regla IVR real)
        if (businessState.confirmAttempts >= 2) {
          // 🔥 ACEPTACIÓN IMPLÍCITA: Si no dice NO después de 2 intentos, asumimos SÍ
          log("info", `✅ [STATE] Aceptación implícita después de ${businessState.confirmAttempts} intentos. Transcript: "${cleanTranscript}"`);

          const fullRutRaw = `${businessState.rutBody}-${businessState.rutDv}`;
          const normalized = normalizeRut(fullRutRaw);
          businessState.dni = normalized;
          businessState.rutPhase = 'COMPLETE';
          businessState.confirmAttempts = 0;

          log("info", `✅ [STATE] CONFIRM(IMPLICIT) -> COMPLETE (RUT Validado: ${normalized})`);

          // Búsqueda en DB
          let patient = await getPatientByRut(normalized);
          if (!patient) {
            const formattedForDb = formatRut(normalized);
            patient = await getPatientByRut(formattedForDb);
          }

          if (patient) {
            businessState.patient = patient;
            result.ttsText = `Gracias. He validado sus datos y lo encontré en el sistema como ${patient.nombre_completo}. ¿En qué puedo ayudarle?`;
          } else {
            result.ttsText = `RUT correctamente validado. No tengo datos previos suyos en el sistema, pero puedo ayudarle. ¿Qué necesita?`;
          }
        } else {
          // Primer intento UNKNOWN: repetir confirmación con mensaje más corto
          const maskedReading = getMaskedRutReading(businessState.rutBody, businessState.rutDv);

          if (businessState.confirmAttempts === 1) {
            // Primer intento: mensaje completo pero DIFERENTE al anterior para evitar Anti-Replay
            result.ttsText = `No le entendí bien. Tengo registrado el RUT terminado en ${maskedReading}. ¿Es correcto?`;
          } else {
            // Segundo intento: mensaje corto y directo
            result.ttsText = `¿Es correcto, sí o no?`;
          }

          log("info", `🔄 [STATE] CONFIRM(UNKNOWN) -> Repetir confirmación. Intento #${businessState.confirmAttempts}`);
        }
      }
      break;

    case 'COMPLETE':
    case 'FAILED':
      log("warn", `⚠️ [STATE] Entrando a handleRutState en estado final ${businessState.rutPhase}`);
      break;

    default:
      log("error", `❌ [STATE] Estado desconocido: ${businessState.rutPhase}`);
      result.ttsText = "Ha ocurrido un error interno. Le transferiré con una ejecutiva.";
      result.shouldHangup = true;
      break;
  }

  // Fallback por intentos excesivos en Strict Mode (aumentado a 5 para adultos mayores)
  if (businessState.rutAttempts >= 5) {
    log("warn", "🚨 [RUT STATE] Max intentos excedidos (5).");
    result.ttsText = "Lo siento, no logro capturar bien los datos. Le transferiré con un ejecutivo para que le ayude.";
    businessState.rutPhase = 'ERROR';
    result.shouldHangup = true;
  }

  return result;
}

/**
 * 🧠 Lógica de Negocio General (Normal Mode)
 * Maneja Agenda, Transferencias y Detección de intención de RUT
 */
async function runBusinessLogic(transcript, assistantResponse, businessState, conversationState, ari, channel, openaiClient, linkedId) {
  const cleanTranscript = (transcript || "").toLowerCase();

  // 1. Detección de Intención de dar RUT (si estamos en 'NONE')
  // Si el usuario dice "mi rut es...", "tengo hora", "quiero pedir hora" -> activamos RUT flow
  if (businessState.rutPhase === 'NONE') {
    const intentionKeywords = ['rut', 'carnet', 'identidad', 'hora', 'medico', 'doctor', 'cita', 'agendar', 'horas'];
    const hasIntention = intentionKeywords.some(w => cleanTranscript.includes(w));

    // También si detectamos un número largo tipo RUT
    const rutCandidate = extractRutCandidate(cleanTranscript);

    if (hasIntention || rutCandidate.body) {
      log("info", `💡 [LOGIC] Intención detectada. Activando RUT Flow.`);
      if (rutCandidate.body) {
        // Si ya dio el cuerpo, lo guardamos y pasamos directo a WAIT_DV
        businessState.rutBody = rutCandidate.body;
        businessState.rutPhase = 'WAIT_DV'; // Próximo turno será Strict Mode WAIT_DV

        // Ojo: Como estamos en Modo Normal (ya se generó audio LLM), 
        // el LLM podría haber dicho "cuál es su rut" o "gracias".
        // Si el LLM preguntó el RUT, el usuario responderá en el siguiente turno.
        // Si el usuario YA lo dijo, debemos asegurarnos que el LLM pida el DV en la sgte interacción.
        // Esto es complejo en modo mixto. 
        // Simplificación: Si detectamos RUT, forzamos Strict Mode para "refinar" o "pedir DV".
      } else {
        businessState.rutPhase = 'WAIT_BODY';
      }
    }
  }

  // 2. Detección de Especialidad y Agenda (Solo si ya tenemos DNI identificado o estamos en flujo libre)
  // MEJORADO: Detectar intención explícita "quiero hora" o implícita (solo especialidad)
  const explicitAgenda = ['hora', 'cita', 'agendar', 'ver', 'reservar'].some(w => cleanTranscript.includes(w));
  const detectedSpecialty = detectSpecialty(cleanTranscript);

  // Si detectamos especialidad (nueva) o tenemos una pendiente (businessState.specialty) pero no slot reservado
  const activeSpecialty = detectedSpecialty || businessState.specialty;
  const isBookingIntent = (detectedSpecialty && (explicitAgenda || !businessState.heldSlot)) || (businessState.specialty && explicitAgenda);

  if (activeSpecialty && isBookingIntent && !businessState.heldSlot) {
    businessState.specialty = activeSpecialty;
    log('info', `🎯 [AGENDA] Intención de agendar para: ${activeSpecialty}`);

    // 🧠 CLASIFICACIÓN DE INTENCIÓN DE FECHA
    const dateClass = await classifyInput({
      phase: 'DATE_INTENT',
      userText: cleanTranscript
    });

    let dateType = 'UNKNOWN';
    let specificDate = null;

    if (dateClass.ok && dateClass.result) {
      dateType = dateClass.result.date_type;
      specificDate = dateClass.result.date;
      log('info', `🧠 [CLASSIFIER] DATE_INTENT: ${dateType} (${specificDate})`);
    }

    if (dateType === 'NEXT_AVAILABLE' || (dateType === 'UNKNOWN' && detectedSpecialty)) {
      // Caso 1: "La más próxima" o default (si acaba de decir la especialidad, asumimos próxima)
      // Nota: Si dateType es UNKNOWN pero detectamos la especialidad recién, intentamos buscar la próxima
      // para ser proactivos, salvo que el usuario haya dicho algo muy ambiguo.
      // Si el usuario dijo "Kinesiólogo" a secas -> Next Available.

      // 🎯 EVENTO 3: DELEGAR GET_NEXT_AVAILABILITY AL WEBHOOK
      const rutFormatted = businessState.dni || businessState.rutFormatted || (businessState.rutBody && businessState.rutDv ? `${businessState.rutBody}-${businessState.rutDv}` : null);

      if (!rutFormatted || !rutFormatted.includes('-')) {
        log('warn', `⚠️ [AGENDA] No hay RUT válido para buscar disponibilidad`);
        await openaiClient.sendSystemText(
          `SISTEMA: Primero necesito validar su RUT. Por favor, indíqueme su RUT completo.`
        );
      } else {
        log('info', `🗓️ [AGENDA] Buscando PRÓXIMA DISPONIBLE para ${activeSpecialty}`);
        const slot = await getAndHoldNextSlot(activeSpecialty, linkedId);

        if (slot) {
          businessState.heldSlot = slot;
          const slotTime = slot.hora_disponible ? slot.hora_disponible.toString().slice(0, 5) : '';
          const slotDate = slot.fecha ? new Date(slot.fecha).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
          const doctor = slot.doctor_box || 'un especialista';

          await openaiClient.sendSystemText(
            `SISTEMA: Cupo reservado: ${activeSpecialty} con ${doctor} el ${slotDate} a las ${slotTime}. Pregunta si confirma.`
          );
        } else {
          log('warn', `⚠️ [AGENDA] Sin cupos próximos para ${activeSpecialty}`);
          await openaiClient.sendSystemText(
            `SISTEMA: No hay horas disponibles para ${activeSpecialty}. Informa y ofrece otra opción.`
          );
        }
      }
    }
    else if (dateType === 'EXACT_DATE' && specificDate) {
      // Caso 2: Fecha específica ("El lunes", "El 3 de enero")
      log('info', `🗓️ [AGENDA] Buscando para FECHA EXACTA: ${specificDate}`);
      // Usamos getAvailabilityBySpecialty para VER si hay horas (no holdear aun, o holdear la primera)
      // Como es voicebot, mejor intentar holdear la primera de esa fecha si existe lógica,
      // pero la función actual listaba.
      // Vamos a usar la función de lista y ofrecer la primera.
      const slots = await import('../shared/db-queries.js').then(m => m.getAvailabilityBySpecialty(activeSpecialty, specificDate));

      if (slots && slots.length > 0) {
        // Tomamos la primera para ofrecer
        // FALTA: Una función para HOLD specific slot by ID. 
        // Como no tenemos "HoldSlotById" expuesto fácil, y el usuario quiere fluidez,
        // simularemos éxito informativo y pediremos confirmación para gatillar el agendamiento real
        // OJO: Esto tiene riesgo de carrera. Lo ideal sería Holdear.
        // Asumiremos que el usuario quiere la primera de esa fecha.
        // Intento "inteligente": Llamar a getAndHoldNextSlot pero forzando fecha? No lo soporta.
        // Por ahora, listamos.
        const first = slots[0];
        const time = first.hora_disponible.toISOString().split('T')[1].slice(0, 5);
        await openaiClient.sendSystemText(
          `SISTEMA: Para el ${specificDate} tengo hora a las ${time} con ${first.doctor_box}. ¿Le sirve?`
        );
        // Hack: Guardamos "meta-data" para saber que si dice SI, es esa.
        // Pero businessState.heldSlot espera un objeto de DB.
        // Podríamos inyectarlo manualmente si confiamos.
        businessState.heldSlot = {
          id_disponibilidad: first.id_disponibilidad,
          fecha: first.fecha,
          hora_disponible: first.hora_disponible,
          especialidad: first.especialidad,
          doctor_box: first.doctor_box,
          requisito: first.requisito
        };
        // Debemos marcarlo en DB como Hold? Sí, deberíamos.
        // Pero sin el SP adecuado, saltamos este paso de seguridad estricta por ahora 
        // (Riesgo aceptado para prototipo: hold lógico en memoria bot).
      } else {
        await openaiClient.sendSystemText(
          `SISTEMA: No quedan horas para el ${specificDate}. Pregunta si quiere ver la fecha más próxima disponible.`
        );
      }
    }
    else {
      // Caso 3: UNKNOWN (y no es solo especialidad, es algo raro)
      log('info', `❓ [AGENDA] Intención de fecha desconocida o ambigua.`);
      await openaiClient.sendSystemText(
        `SISTEMA: El usuario quiere ${activeSpecialty} pero no entendí para cuándo. Pregunta: ¿Para cuándo necesita la hora?`
      );
    }
  }


  // 3. Confirmación (HOLD -> OCUPADO)
  if (businessState.heldSlot && (cleanTranscript.includes("si") || cleanTranscript.includes("confirmo"))) {
    // ... Agendar ...
    // (Copiar lógica de scheduling del bloque original)
    const slot = businessState.heldSlot;
    const result = await scheduleAppointment(businessState.dni || 'SIN_RUT', new Date(slot.fecha), businessState.specialty, 'voicebot', linkedId);
    if (result.ok) {
      await openaiClient.sendSystemText(`SISTEMA: Cita confirmada ID ${result.id}. Despídete.`);
      businessState.heldSlot = null;
    }
  }

  // 4. Transferencia semántica
  if (shouldTransferToQueue(transcript, assistantResponse)) {
    log("info", `📞 [LOGIC] Transferencia semántica detectada.`);
    await transferToQueue(ari, channel, QUEUES_NAME || "cola_ventas");
    conversationState.active = false;
  }
}
