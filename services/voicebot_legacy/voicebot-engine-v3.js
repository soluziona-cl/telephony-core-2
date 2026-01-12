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
import { OpenAIRealtimeClientV3 } from "./voicebot-openai-realtime-v3.js";
import { log } from "../../lib/logger.js";
import config from "./voicebot.config.js";


const execAsync = promisify(exec);

const VOICEBOT_PATH = config.paths.voicebot;
const ASTERISK_REC_PATH = config.paths.recordings;

const MIN_WAV_SIZE_BYTES = config.audio.minWavSizeBytes;
const MAX_TURNS_PER_CALL = config.engine.maxTurns;
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

    const shouldTransfer = transferPhrases.some(phrase => lowerResponse.includes(phrase));
    if (shouldTransfer) {
      log("info", `🎯 [Transferencia] Detectada en respuesta del asistente: "${assistantResponse}"`);
    }
    return shouldTransfer;
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

  const detected = TRANSFER_KEYWORDS.some(keyword => lowerTranscript.includes(keyword));

  if (detected) {
    log("info", `🎯 [Transferencia] Palabra clave detectada: "${transcript}"`);
  }

  return detected;
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
    log("debug", `📁 Tamaño grabación: ${stats.size} bytes (mín: ${MIN_WAV_SIZE_BYTES})`);

    return stats.size >= MIN_WAV_SIZE_BYTES;
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
async function playWithBargeIn(ari, channel, fileBaseName, openaiClient) {
  const media = `sound:voicebot/${fileBaseName}`;
  const playback = ari.Playback();

  log("info", `🔊 [VB V3] Reproduciendo (barge-in activo): ${media}`);

  return new Promise((resolve) => {
    let bargedIn = false;
    let finished = false;
    let talkingTimer = null;
    const startedAt = Date.now();

    const talkingHandler = (event, chan) => {
      if (!chan || chan.id !== channel.id) return;
      if (finished) return;

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
      log("debug", `✅ Playback completado: ${media}`);
      cleanup();
      resolve({ reason: bargedIn ? "barge-in" : "finished" });
    });

    playback.on("PlaybackStopped", () => {
      if (finished) return;
      log("debug", `🛑 Playback detenido: ${media}`);
      cleanup();
      resolve({ reason: bargedIn ? "barge-in" : "stopped" });
    });

    playback.on("PlaybackFailed", (evt) => {
      if (finished) return;
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
    log("warn", `🤫 [VB V3] Grabación con poco audio: ${wavFile}`);
    return { ok: false, reason: "silence", path: wavFile };
  }

  log("info", `✅ Grabación válida: ${wavFile} (${result.duration}s)`);
  return { ok: true, reason: "ok", path: wavFile, recId };
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
async function playGreeting(ari, channel, openaiClient) {
  log("info", "👋 [VB V3] Generando saludo inicial...");

  try {
    const audioBuffer = await openaiClient.sendTextAndWait("Hola");

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

    await playWithBargeIn(ari, channel, rspId, openaiClient);

    log("info", "✅ Saludo inicial completado");
    return true;

  } catch (err) {
    log("error", `❌ Error generando saludo: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------
// 💬 Prompt "¿Sigues ahí?"
// ---------------------------------------------------------
async function playStillTherePrompt(ari, channel, openaiClient) {
  log("info", "❓ [VB V3] Reproduciendo prompt: ¿Sigues ahí?");

  try {
    const audioBuffer = await openaiClient.sendTextAndWait("¿Sigues ahí?");

    if (!audioBuffer || audioBuffer.length === 0) {
      log("warn", "⚠️ No se recibió audio del prompt");
      return false;
    }

    const rspId = `vb_still_there_${Date.now()}`;
    const rawPcmFile = `/tmp/${rspId}.pcm`;
    const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

    fs.writeFileSync(rawPcmFile, audioBuffer);

    const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
    await execAsync(cmd);

    await playWithBargeIn(ari, channel, rspId, openaiClient);

    log("info", "✅ Prompt 'Sigues ahí' completado");
    return true;

  } catch (err) {
    log("error", `❌ Error en prompt 'Sigues ahí': ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------
// 💬 Prompt "¿Comprendo?" tras barge-in
// ---------------------------------------------------------
async function playComprendoPrompt(ari, channel, openaiClient) {
  log("info", "❓ [VB V3] Reproduciendo prompt: ¿Comprendo?");

  try {
    const audioBuffer = await openaiClient.sendTextAndWait("Disculpa, ¿comprendo que quieres interrumpir?");

    if (!audioBuffer || audioBuffer.length === 0) {
      log("warn", "⚠️ No se recibió audio del prompt");
      return false;
    }

    const rspId = `vb_comprendo_${Date.now()}`;
    const rawPcmFile = `/tmp/${rspId}.pcm`;
    const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

    fs.writeFileSync(rawPcmFile, audioBuffer);

    const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
    await execAsync(cmd);

    // No usar barge-in en este prompt (es corto)
    const media = `sound:voicebot/${rspId}`;
    await channel.play({ media }).catch(err =>
      log("warn", `Error reproduciendo prompt comprendo: ${err.message}`)
    );

    log("info", "✅ Prompt 'Comprendo' completado");
    return true;

  } catch (err) {
    log("error", `❌ Error en prompt 'Comprendo': ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------
// 🔄 Transferir a cola de ventas
// ---------------------------------------------------------
async function transferToQueue(ari, channel, queueName = "cola_ventas") {
  log("info", `📞 [VB V3] INICIANDO Transferencia a cola: ${queueName}`);
  log("debug", `🔍 [Transferencia] Canal ID: ${channel.id}, Estado: ${channel.state}, LinkedId: ${channel.linkedid}`);

  try {
    // Intentar reproducir mensaje de transferencia
    try {
      await channel.play({
        media: "sound:transfer"
      }).catch(() => {
        log("debug", "Audio de transferencia no disponible, continuando...");
      });

      // Esperar que termine el audio
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      log("debug", "Sin audio de transferencia, continuando...");
    }

    log("info", `🔄 [Transferencia] Redirigiendo a contexto: queues, extensión: ${queueName}`);

    // Redirigir a la cola usando el contexto de dialplan
    await channel.continueInDialplan({
      context: "queues",
      extension: queueName,
      priority: 1
    });

    log("info", `✅ [VB V3] Transferencia a ${queueName} iniciada`);
    return true;

  } catch (err) {
    log("error", `❌ [VB V3] Error en transferencia: ${err.message}`);
    log("error", `🔍 [Transferencia] Stack trace: ${err.stack}`);
    return false;
  }
}
// ---------------------------------------------------------
// EXPORT: Sesión VoiceBot V3 MEJORADA CON PROMPTS
// ---------------------------------------------------------
export async function startVoiceBotSessionV3(ari, channel, ani, dnis, linkedId) {
  log(
    "info",
    `🤖[VB ENGINE V3] 🚀 Iniciando sesión MEJORADA ANI = ${ ani } DNIS = ${ dnis } LinkedId = ${ linkedId } `
  );

  if (!fs.existsSync(VOICEBOT_PATH)) {
    fs.mkdirSync(VOICEBOT_PATH, { recursive: true });
  }

  let sessionActive = true;
  let silentTurns = 0;
  let successfulTurns = 0;

  const openaiClient = new OpenAIRealtimeClientV3({
    voice: config.openai.voice,
    language: config.openai.language,
    model: config.openai.model
  });

  try {
    await openaiClient.connect();
    log("info", `✅[VB V3] Cliente OpenAI conectado(sesión persistente)`);
  } catch (err) {
    log("error", `❌[VB V3] Error conectando OpenAI: ${ err.message } `);
    return;
  }

  channel.on("StasisEnd", () => {
    log("info", `👋[VB V3] Canal colgó, finalizando sesión`);
    sessionActive = false;
    openaiClient.disconnect();
  });

  // ✅ SALUDO INICIAL
  try {
    log("info", "👋 [VB V3] Reproduciendo saludo inicial...");
    await playGreeting(ari, channel, openaiClient);
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (err) {
    log("warn", `⚠️ Error en saludo inicial: ${ err.message } `);
  }

  for (let turn = 1; sessionActive && turn <= MAX_TURNS_PER_CALL; turn++) {
    log("info", `🔄[VB V3] Turno #${ turn } (silencios: ${ silentTurns }/${MAX_SILENT_TURNS})`);

    // =======================================================
    // 1) Esperar voz real (primeros turnos)
    // =======================================================
    if (turn <= 2 && silentTurns === 0) {
      log("info", "🎤 [VB V3] Esperando voz del usuario...");

      const voiceCheck = await waitForRealVoice(channel, {
        maxWaitMs: 4000,
        minTalkingEvents: 1
      });

      if (!voiceCheck.detected) {
        silentTurns++;
        log("warn", `🤫[VB V3] Sin voz detectada(silencio #${ silentTurns })`);

        // ✅ PROMPT "¿SIGUES AHÍ?" DESPUÉS DEL SEGUNDO SILENCIO
        if (silentTurns === 2) {
          await playStillTherePrompt(ari, channel, openaiClient);
        }

        if (silentTurns >= MAX_SILENT_TURNS) {
          log("info", "🔚 [VB V3] Demasiados silencios, finalizando sesión");
          break;
        }

        continue;
      }

      log("info", `🟩[VB V3] Voz detectada(${ voiceCheck.events } eventos) → iniciando grabación`);
    }

    // =======================================================
    // 2) Grabar turno del usuario
    // =======================================================
    const recResult = await recordUserTurn(channel, turn);

    if (!sessionActive) {
      log("info", `🔚[VB V3] Sesión terminada durante grabación`);
      break;
    }

    if (!recResult.ok) {
      if (recResult.reason === "silence") {
        silentTurns++;
        log("info", `🤫[VB V3] Turno silencioso(#${ silentTurns } / ${ MAX_SILENT_TURNS })`);

        // ✅ PROMPT "¿SIGUES AHÍ?" DESPUÉS DEL SEGUNDO SILENCIO
        if (silentTurns === 2) {
          await playStillTherePrompt(ari, channel, openaiClient);
        }

        if (silentTurns >= MAX_SILENT_TURNS) {
          log("info", `🔚[VB V3] Límite de silencios alcanzado, cerrando sesión`);
          break;
        }

        continue;
      }

      log("warn", `⚠️[VB V3] Error grabación(${ recResult.reason }), finalizando`);
      break;
    }

    silentTurns = 0;
    successfulTurns++;
    const userWavPath = recResult.path;

    log("info", `✅[VB V3] Audio válido recibido(turno exitoso #${ successfulTurns })`);

    // =======================================================
    // 3) Procesar con OpenAI
    // =======================================================
    const responseBaseName = await processUserTurnWithOpenAI(userWavPath, openaiClient);

    if (!sessionActive) {
      log("info", `🔚[VB V3] Sesión terminada durante OpenAI`);
      break;
    }

    if (!responseBaseName) {
      log("warn", `⚠️[VB V3] Sin respuesta OpenAI, finalizando`);
      break;
    }


    // ===============================
    // ========================
    // 4) Verificar si se debe transferir a cola
    // =======================================================
    const shouldTransfer = shouldTransferToQueue(
      openaiClient.lastTranscript,
      openaiClient.lastAssistantResponse
    );

    log("debug", `🔍 [Transferencia] Verificando: transcript="${openaiClient.lastTranscript}", assistant="${openaiClient.lastAssistantResponse}", shouldTransfer=${shouldTransfer}`);

    if (shouldTransfer) {
      log("info", `📞[VB V3] Transferencia detectada: "${openaiClient.lastTranscript || openaiClient.lastAssistantResponse}"`);

      const transferred = await transferToQueue(ari, channel, QUEUES_NAME || "cola_ventas");

      if (transferred) {
        log("info", `✅[VB V3] Sesión finalizada por transferencia exitosa`);
        break;
      } else {
        log("error", `❌[VB V3] Falló la transferencia, continuando sesión`);
      }
    }
    // =======================================================
    // 5) Reproducir respuesta con barge-in
    // =======================================================
    const playbackResult = await playWithBargeIn(ari, channel, responseBaseName, openaiClient);

    if (!sessionActive) {
      log("info", `🔚[VB V3] Sesión terminada durante playback`);
      break;
    }

    if (playbackResult.reason === "failed" || playbackResult.reason === "error") {
      log("warn", `⚠️[VB V3] Playback error(${ playbackResult.reason }), finalizando`);
      break;
    }

    // ✅ PROMPT "¿COMPRENDO?" AL DETECTAR BARGE-IN
    if (playbackResult.reason === "barge-in") {
      log("info", `🔥[VB V3] Barge -in detectado, reproduciendo prompt de confirmación`);
      await playComprendoPrompt(ari, channel, openaiClient);
    }
  }

  openaiClient.disconnect();
  log("info", `🔚[VB ENGINE V3] Sesión finalizada LinkedId = ${ linkedId } (turnos exitosos: ${ successfulTurns })`);
}