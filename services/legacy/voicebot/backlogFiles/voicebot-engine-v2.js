// =========================================================
// VOICEBOT ENGINE V2 - Evoluziona Telephony Core
// - Manejo mejorado de silencio
// - Soporte de barge-in (usuario habla mientras el bot habla)
// - Flujo de turnos más robusto
// =========================================================

import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { askRealtimeAndGetReplyV2 } from "./voicebot-openai-realtime-v2.js";
import { log } from "../../../lib/logger.js";

const execAsync = promisify(exec);

const VOICEBOT_PATH = "/var/lib/asterisk/sounds/voicebot";
const ASTERISK_REC_PATH = "/var/spool/asterisk/recording";

// Umbrales / tiempos
const MIN_WAV_SIZE_BYTES = 8000;          // ~audio mínimo para considerar que habló
const MAX_TURNS_PER_CALL = 20;           // seguridad para evitar loops eternos
const MAX_SILENT_TURNS = 2;              // cuántas veces toleramos que no hable
const MAX_RECORDING_MS = 15000;          // timeout duro de grabación
const PLAYBACK_TIMEOUT_MS = 15000;       // timeout máximo por playback

if (!fs.existsSync(VOICEBOT_PATH)) {
  fs.mkdirSync(VOICEBOT_PATH, { recursive: true });
}

// ---------------------------------------------------------
// Helper: esperar a que exista un archivo (y tenga tamaño > 0)
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
            return resolve(true);
          }
        }

        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          return resolve(false);
        }
      } catch {
        // ignoramos errores transitorios
      }
    }, intervalMs);
  });
}

// ---------------------------------------------------------
// Helper: Validar que la grabación tenga contenido real
// ---------------------------------------------------------
function isValidRecording(path) {
  try {
    if (!fs.existsSync(path)) return false;
    const stats = fs.statSync(path);
    log("debug", `📁 Tamaño archivo grabación: ${stats.size} bytes`);
    return stats.size >= MIN_WAV_SIZE_BYTES;
  } catch (err) {
    log("error", `❌ Error validando grabación: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------
// Helper: Convertir WAV Asterisk → WAV 8kHz MULAW (para pipeline)
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
// Helper: Reproducir audio con soporte de barge-in
// - Requiere TALK_DETECT activado en el dialplan para el canal
// ---------------------------------------------------------
async function playWithBargeIn(ari, channel, fileBaseName) {
  const media = `sound:voicebot/${fileBaseName}`;
  const playback = ari.Playback();

  log("info", `🔊 [VB] Reproduciendo (barge-in): ${media}`);

  return new Promise((resolve) => {
    let bargedIn = false;
    let finished = false;
    const startedAt = Date.now();

    const talkingHandler = (event, chan) => {
      if (!chan || chan.id !== channel.id) return;
      if (finished) return;

      log("info", `🗣️ [VB] Detectado habla del usuario durante playback → barge-in`);
      bargedIn = true;

      // Cortar el audio de inmediato
      playback
        .stop()
        .catch((err) => log("warn", `⚠️ Error al detener playback en barge-in: ${err.message}`));
    };

    const cleanup = () => {
      finished = true;
      // Quitar listener de talking
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

    // Timeout de seguridad: si pasa mucho, cortamos
    const timeoutTimer = setInterval(() => {
      if (finished) {
        clearInterval(timeoutTimer);
        return;
      }
      if (Date.now() - startedAt > PLAYBACK_TIMEOUT_MS) {
        log("warn", `⏰ Timeout en playback: ${media}`);
        playback
          .stop()
          .catch((err) => log("warn", `⚠️ Error al detener playback por timeout: ${err.message}`));
        clearInterval(timeoutTimer);
        // El resolve se hará en PlaybackStopped
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
// Helper: Grabar un turno de usuario con timeout + validación
// ---------------------------------------------------------
async function recordUserTurn(channel) {
  const recId = `vb_${Date.now()}`;
  const wavFile = `${ASTERISK_REC_PATH}/${recId}.wav`;

  log("info", `🎙️ [VB] Preparando grabación: ${recId}`);

  let recordingObj;
  try {
    recordingObj = await channel.record({
      name: recId,
      format: "wav",
      beep: false,
      maxSilenceSeconds: 4,  // silencio interno de Asterisk
      silenceThreshold: 256,
      ifExists: "overwrite"
    });
  } catch (err) {
    log("error", `❌ [VB] Error iniciando grabación: ${err.message}`);
    return { ok: false, reason: "record-start-failed" };
  }

  log("info", `🎙️ [VB] Grabación iniciada: ${recId}`);

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
      log("info", `🎙️ [VB] Grabación finalizada: ${recId}.wav`);
      cleanup();
      resolve({ ok: true, reason: "finished" });
    });

    recordingObj.on("RecordingFailed", (evt) => {
      if (finished) return;
      log("error", `❌ [VB] RecordingFailed para ${recId}: ${JSON.stringify(evt)}`);
      cleanup();
      resolve({ ok: false, reason: "record-failed" });
    });

    // Timeout global por seguridad
    const timer = setInterval(() => {
      if (finished) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - startedAt > MAX_RECORDING_MS) {
        log("warn", `⏰ Timeout global de grabación: ${recId}`);
        try {
          recordingObj
            .stop()
            .catch((err) =>
              log("warn", `⚠️ Error al detener grabación por timeout: ${err.message}`)
            );
        } catch (err) {
          log("warn", `⚠️ Excepción al detener grabación: ${err.message}`);
        }
        clearInterval(timer);
        // El resolve se hará en RecordingFinished / RecordingFailed o queda sin archivo
      }
    }, 500);
  });

  // Esperar a que Asterisk termine de escribir el archivo en disco
  const exists = await waitForFile(wavFile, 3000, 100);
  if (!exists) {
    log("error", `❌ Archivo de grabación no existe: ${wavFile}`);
    return { ok: false, reason: "file-not-found" };
  }

  if (!isValidRecording(wavFile)) {
    log("warn", `🤫 [VB] Grabación con poco audio (silencio o ruido): ${wavFile}`);
    return { ok: false, reason: "silence", path: wavFile };
  }

  log("info", `✅ Grabación válida: ${wavFile}`);
  return { ok: true, reason: "ok", path: wavFile, recId };
}

// ---------------------------------------------------------
// Helper: Pipeline completo de turno
// - Recibe WAV de usuario, convierte, llama a OpenAI, guarda WAV de respuesta
// ---------------------------------------------------------
async function processUserTurnWithOpenAI(userWavPath) {
  // 1) Convertir a WAV 8k MULAW para mantener compatibilidad con pipeline actual
  const recId = `vb_${Date.now()}`;
  const processedUserWav = `${VOICEBOT_PATH}/${recId}_8k.wav`;

  try {
    await convertWavToWav8000(userWavPath, processedUserWav);
  } catch (err) {
    log("error", `❌ [VB] Error conversión ffmpeg input→8k: ${err.message}`);
    return null;
  }

  // 2) Enviar a OpenAI Realtime y obtener PCM16 24k
  let responsePcm;
  try {
    // 👉 Aquí puedes mejorar el comportamiento agregando instrucciones en el helper
    // (más abajo te doy un mini parche para eso)
    responsePcm = await askRealtimeAndGetReplyV2(processedUserWav);
  } catch (err) {
    log("error", `❌ [VB] OpenAI error: ${err.message}`);
    return null;
  }

  if (!responsePcm || !responsePcm.length) {
    log("warn", `⚠️ [VB] OpenAI devolvió audio vacío`);
    return null;
  }

  // 3) Guardar PCM y convertir a WAV 8k reproducible por Asterisk
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
    log("error", `❌ Error convirtiendo PCM→WAV: ${err.message}`);
    return null;
  }

  log("info", `✅ Archivo de respuesta creado: ${finalWavFile}`);
  return rspId; // baseName para playback: sound:voicebot/<rspId>
}

// ---------------------------------------------------------
// EXPORT: sesión de VoiceBot con mejoras
// ---------------------------------------------------------
export async function startVoiceBotSessionV2(ari, channel, ani, dnis, linkedId) {
  log(
    "info",
    `🤖 [VB ENGINE V2] Iniciando sesión ANI=${ani} DNIS=${dnis} LinkedId=${linkedId}`
  );

  // Asegurar carpeta de salida
  if (!fs.existsSync(VOICEBOT_PATH)) {
    fs.mkdirSync(VOICEBOT_PATH, { recursive: true });
  }

  let sessionActive = true;
  let silentTurns = 0;

  channel.on("StasisEnd", () => {
    log("info", `👋 [VB V2] Canal colgó (StasisEnd), finalizando sesión.`);
    sessionActive = false;
  });

  for (let turn = 1; sessionActive && turn <= MAX_TURNS_PER_CALL; turn++) {
    log("info", `🔄 [VB V2] Turno #${turn}`);

    // 1) Grabar al usuario
    const recResult = await recordUserTurn(channel);

    if (!sessionActive) {
      log("info", `🔚 [VB V2] Sesión terminada durante grabación (hangup).`);
      break;
    }

    if (!recResult.ok) {
      if (recResult.reason === "silence") {
        silentTurns++;
        log("info", `🤫 [VB V2] Turno silencioso (#${silentTurns})`);

        if (silentTurns >= MAX_SILENT_TURNS) {
          log(
            "info",
            `🔚 [VB V2] Demasiados turnos silenciosos (${silentTurns}), cerrando sesión.`
          );
          break;
        }

        // Opcional: aquí podrías reproducir un prompt tipo "¿Sigues ahí?" usando un audio fijo.
        // Por ahora solo continuamos al siguiente turno.
        continue;
      }

      // Otros errores: si no se pudo grabar, terminamos la sesión
      log(
        "warn",
        `⚠️ [VB V2] Error en grabación (reason=${recResult.reason}), finalizando sesión.`
      );
      break;
    }

    silentTurns = 0; // reseteamos contador de silencio

    const userWavPath = recResult.path;

    // 2) Procesar con OpenAI
    const responseBaseName = await processUserTurnWithOpenAI(userWavPath);

    if (!sessionActive) {
      log("info", `🔚 [VB V2] Sesión terminada mientras se procesaba OpenAI.`);
      break;
    }

    if (!responseBaseName) {
      log(
        "warn",
        `⚠️ [VB V2] No se obtuvo respuesta de OpenAI en turno #${turn}, terminando sesión.`
      );
      break;
    }

    // 3) Reproducir respuesta con barge-in habilitado
    const playbackResult = await playWithBargeIn(ari, channel, responseBaseName);

    if (!sessionActive) {
      log("info", `🔚 [VB V2] Sesión terminada durante playback.`);
      break;
    }

    if (playbackResult.reason === "failed" || playbackResult.reason === "error") {
      log(
        "warn",
        `⚠️ [VB V2] Playback con problemas (reason=${playbackResult.reason}), finalizando.`
      );
      break;
    }

    // Si hay barge-in, el usuario ya empezó a hablar → en el próximo turno
    // volvemos a grabar inmediatamente.
  }

  log("info", `🔚 [VB ENGINE V2] Sesión finalizada LinkedId=${linkedId}`);
}
