// ====================================================================
// 🔥 VoiceBot Realtime v2 — Asterisk ARI + OpenAI Realtime
// --------------------------------------------------------------------
// • Bridge mixing FULL-DUPLEX
// • Reproducción estable (Asterisk sound:voicebot/...)
// • Integración con OpenAI Realtime (audio bidireccional)
// • Manejo robusto de turnos, silencios y cortes
// ====================================================================

import fs from "fs";
import { randomUUID } from "crypto";
import { log } from "../../lib/logger.js";
import { convertWavToUlaw } from "./audio-utils.js";
import { OpenAIRealtimeClient } from "./voicebot-openai-realtime.js";

// Directorio final donde Asterisk reproduce audios
const SOUND_DIR = "/var/lib/asterisk/sounds/voicebot";

// Crear carpeta si no existe
if (!fs.existsSync(SOUND_DIR)) {
    fs.mkdirSync(SOUND_DIR, { recursive: true });
    fs.chownSync(SOUND_DIR, 999, 999); // usuario asterisk
}

// ====================================================================
// 🔥 INICIO SESIÓN VoiceBot
// ====================================================================

export async function startVoiceBotSession(ari, channel, ani, dnis) {
    log("info", `🤖 [VB] Session start ANI=${ani} DNIS=${dnis}`);

    // ----------------------------------------------------------------
    // 1) Bridge MIXING
    // ----------------------------------------------------------------
    const bridge = ari.Bridge();
    await bridge.create({ type: "mixing", name: `vb-${channel.id}` });

    await bridge.addChannel({ channel: channel.id });
    log("info", `🔗 Bridge mixing creado y canal agregado`);

    let finished = false;
    channel.on("StasisEnd", () => { finished = true; });

    // ----------------------------------------------------------------
    // 2) Reproducir mensaje inicial
    // ----------------------------------------------------------------
    try {
        await bridge.play({ media: "sound:demo-congrats" });
    } catch { }

    // ----------------------------------------------------------------
    // 3) Loop de interacción (turnos)
    // ----------------------------------------------------------------
    while (!finished) {
        const userAudio = await recordUserTurn(ari, bridge);
        if (!userAudio) break;

        const replyUlaw = await askRealtimeAndGetReply(userAudio);
        if (!replyUlaw) break;

        try {
            await bridge.play({ media: `sound:voicebot/${replyUlaw}` });
        } catch (e) {
            log("warn", `⚠️ Error reproduciendo respuesta: ${e.message}`);
        }
    }

    log("info", `🔚 VoiceBot terminado para canal ${channel.id}`);
}

// ====================================================================
// 🔥 Grabación usando BRIDGE (full-duplex)
// ====================================================================

async function recordUserTurn(ari, bridge) {

    return new Promise(async (resolve) => {

        const recId = `vb_${randomUUID()}`;
        const recFile = `/tmp/${recId}.wav`;

        log("info", `🎙️ [VB] Iniciando grabación turno: ${recId}`);

        let recording = null;

        try {
            recording = await bridge.record({
                name: recId,
                format: "wav",
                maxDurationSeconds: 30,
                maxSilenceSeconds: 1.8,
                ifExists: "overwrite",
                beep: false,
                terminateOn: "none"
            });
        } catch (err) {
            log("error", `❌ Error start recording: ${err.message}`);
            return resolve(null);
        }

        const onFinished = (event, rec) => {
            if (rec.name !== recId) return;

            ari.removeListener("RecordingFinished", onFinished);

            log("info", `✅ [VB] Grabación terminada: ${recFile}`);

            if (fs.existsSync(recFile)) resolve(recFile);
            else resolve(null);
        };

        ari.on("RecordingFinished", onFinished);
    });
}

// ====================================================================
// 🔥 Llamada a OpenAI Realtime → devuelve archivo ULaw listo
// ====================================================================

async function askRealtimeAndGetReply(audioPath) {
    try {
        const client = new OpenAIRealtimeClient({
            voice: "alloy",
            instructions: "Eres un asistente telefónico amable y eficiente. Responde conciso y claro.",
            language: "es"
        });

        await client.connect();
        const replyPcm = await client.processAudioFile(audioPath);

        if (!replyPcm) return null;

        const wavBuffer = replyPcm;

        // Convertir WAV → ULaw
        const ulawTempPath = await convertWavToUlaw(wavBuffer);
        const id = ulawTempPath.split("/").pop().replace(".ulaw", "");

        const finalPath = `${SOUND_DIR}/${id}.ulaw`;

        fs.copyFileSync(ulawTempPath, finalPath);
        fs.chownSync(finalPath, 999, 999);

        log("info", `🔊 Audio final listo: ${finalPath}`);

        return id; // Asterisk reproducirá sound:voicebot/<id>
    }
    catch (err) {
        log("error", `❌ Error en OpenAI Realtime: ${err.message}`);
        return null;
    }
}


//Codigo anterior.
// import WebSocket from "ws";
// import fs from "fs";
// import { randomUUID } from "crypto";
// import { log } from "../../lib/logger.js";
// import { convertWavToUlaw } from "./audio-utils.js";

// export async function startVoiceBotSession(ari, channel, ani, dnis) {
//     log("info", `🤖 [VB] Session start ANI=${ani} DNIS=${dnis}`);

//     let finished = false;
//     channel.on("StasisEnd", () => { finished = true; });

//     try {
//         await channel.play({ media: "sound:demo-congrats" });
//     } catch { }

//     while (!finished) {
//         const userAudio = await recordUserTurn(ari, channel);
//         if (!userAudio) break;

//         const replyUlaw = await askRealtimeAndGetReply(userAudio);
//         if (!replyUlaw) break;

//         try {
//             await channel.play({ media: `sound:${replyUlaw}` });
//         } catch (e) {
//             log("warn", `⚠️ Error reproduciendo respuesta: ${e.message}`);
//         }
//     }
// }

// /**
//  * 🔥 Grabación usando el API correcto de ARI
//  */
// async function recordUserTurn(ari, channel) {
//     return new Promise(async (resolve) => {
//         const recId = `vb_${randomUUID()}`;
//         const recFile = `/var/spool/asterisk/recording/${recId}.wav`;

//         log("info", `🎙️ [VB] Iniciando grabación turno: ${recId}`);

//         let recording = null;

//         try {
//             // ✅ FORMA CORRECTA: usar ari.channels.record()
//             recording = await channel.record({
//                 name: recId,
//                 format: "wav",
//                 maxDurationSeconds: 30,
//                 maxSilenceSeconds: 2,
//                 ifExists: "overwrite",
//                 beep: false,
//                 terminateOn: "none"
//             });

//             log("info", `✅ [VB] Grabación iniciada: ${recId}`);

//         } catch (err) {
//             log("error", `❌ Error start recording: ${err.message}`);
//             return resolve(null);
//         }

//         // Escuchar evento RecordingFinished
//         const onRecordingFinished = (event, rec) => {
//             if (rec.name !== recId) return;

//             log("info", `✅ [VB] Grabación terminada: ${recId}`);

//             // Limpiar listeners
//             ari.removeListener("RecordingFinished", onRecordingFinished);
//             channel.removeListener("StasisEnd", onChannelEnd);

//             if (fs.existsSync(recFile)) {
//                 resolve(recFile);
//             } else {
//                 log("warn", `⚠️ Archivo de grabación no encontrado: ${recFile}`);
//                 resolve(null);
//             }
//         };

//         const onChannelEnd = () => {
//             log("warn", `⚠️ Canal terminado durante grabación: ${recId}`);
//             ari.removeListener("RecordingFinished", onRecordingFinished);
//             channel.removeListener("StasisEnd", onChannelEnd);

//             // Intentar detener la grabación si existe
//             if (recording) {
//                 try {
//                     recording.stop().catch(() => { });
//                 } catch { }
//             }

//             resolve(null);
//         };

//         ari.on("RecordingFinished", onRecordingFinished);
//         channel.on("StasisEnd", onChannelEnd);
//     });
// }

// /**
//  * 🤖 Integración con OpenAI Realtime
//  */
// async function askRealtimeAndGetReply(audioPath) {
//     log("info", `🤖 [VB] Procesando audio: ${audioPath}`);

//     try {
//         const { askRealtimeAndGetReply: openaiAsk } = await import("./voicebot-openai-realtime.js");

//         // Configuración personalizable
//         const config = {
//             instructions: "Eres un asistente telefónico profesional y amable. Responde de manera clara, concisa y útil.",
//             voice: "alloy", // opciones: alloy, echo, shimmer
//             language: "es"
//         };

//         // Obtener respuesta de OpenAI (retorna PCM16)
//         const pcm16Buffer = await openaiAsk(audioPath, config);

//         if (!pcm16Buffer) {
//             log("warn", `⚠️ [VB] OpenAI no retornó audio`);
//             return null;
//         }

//         // Convertir PCM16 a μ-law para Asterisk
//         const ulawPath = await convertPCM16ToUlaw(pcm16Buffer);
//         return ulawPath;

//     } catch (error) {
//         log("error", `❌ [VB] Error con OpenAI: ${error.message}`);
//         return null;
//     }
// }

// /**
//  * 🔄 Convierte PCM16 a μ-law para Asterisk
//  */
// async function convertPCM16ToUlaw(pcm16Buffer) {
//     const { spawn } = await import("child_process");
//     const { randomUUID } = await import("crypto");

//     const id = randomUUID();
//     const pcmPath = `/tmp/${id}.pcm`;
//     const ulawPath = `/tmp/${id}.ulaw`;

//     fs.writeFileSync(pcmPath, pcm16Buffer);

//     return new Promise((resolve, reject) => {
//         const ffmpeg = spawn("ffmpeg", [
//             "-y",
//             "-f", "s16le",
//             "-ar", "24000",
//             "-ac", "1",
//             "-i", pcmPath,
//             "-ar", "8000",   // Asterisk usa 8kHz
//             "-f", "mulaw",
//             ulawPath
//         ]);

//         ffmpeg.on("close", (code) => {
//             fs.unlinkSync(pcmPath); // Limpiar

//             if (code !== 0) {
//                 reject(new Error(`FFmpeg error: ${code}`));
//             } else {
//                 resolve(ulawPath);
//             }
//         });
//     });
// }