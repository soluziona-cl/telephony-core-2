// =========================================================
// VOICEBOT ENGINE - Versión Corregida
// =========================================================

import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { askRealtimeAndGetReply } from "./voicebot-openai-realtime.js";
import { log } from "../../lib/logger.js";

const execAsync = promisify(exec);
const VOICEBOT_PATH = "/var/lib/asterisk/sounds/voicebot";
const ASTERISK_REC_PATH = "/var/spool/asterisk/recording";

if (!fs.existsSync(VOICEBOT_PATH)) {
    fs.mkdirSync(VOICEBOT_PATH, { recursive: true });
}

// Convertir WAV a formato compatible
async function convertWavToWav8000(inputWav, outputWav) {
    try {
        await execAsync(`ffmpeg -y -i "${inputWav}" -ar 8000 -ac 1 -codec:a pcm_mulaw "${outputWav}"`);
        return true;
    } catch (err) {
        log("error", `❌ FFmpeg conversion failed: ${err.message}`);
        return false;
    }
}

// Reproducir audio - VERSIÓN MEJORADA
async function playAudioToUser(ari, channel, fileBaseName) {
    // Usar solo el nombre base sin extensión
    const soundName = fileBaseName.replace('.wav', '');
    const soundUri = `sound:voicebot/${soundName}`;
    
    log("info", `🔊 [VB] Reproduciendo: ${soundUri}`);
    
    return new Promise((resolve) => {
        const playback = ari.Playback();
        let playbackCompleted = false;

        const cleanup = () => {
            playback.removeAllListeners();
        };

        const complete = (success) => {
            if (!playbackCompleted) {
                playbackCompleted = true;
                cleanup();
                resolve(success);
            }
        };

        playback.once("PlaybackFinished", () => {
            log("debug", `✅ Playback completado: ${soundUri}`);
            complete(true);
        });

        playback.once("PlaybackFailed", (err) => {
            log("error", `❌ Playback falló: ${soundUri} - ${JSON.stringify(err)}`);
            complete(false);
        });

        // Timeout más corto
        const timeout = setTimeout(() => {
            log("warn", `⏰ Timeout en playback: ${soundUri}`);
            complete(false);
        }, 10000);

        // Iniciar reproducción
        channel.play({ media: soundUri }, playback)
            .then(() => {
                log("debug", `🎵 Playback iniciado: ${soundUri}`);
            })
            .catch(err => {
                log("error", `❌ Error iniciando playback: ${err.message}`);
                clearTimeout(timeout);
                complete(false);
            });
    });
}

// Grabar audio - VERSIÓN MEJORADA
async function recordUserAudio(channel, recId) {
    const wavFile = `${ASTERISK_REC_PATH}/${recId}.wav`;
    
    return new Promise(async (resolve) => {
        try {
            // Limpiar archivo existente si existe
            if (fs.existsSync(wavFile)) {
                fs.unlinkSync(wavFile);
            }

            // Esperar antes de grabar
            await new Promise(r => setTimeout(r, 500));

            // Reproducir beep antes de grabar
            await channel.play({ media: "sound:beep" })
                .catch(() => log("warn", "Beep no pudo reproducirse"));

            const recording = await channel.record({
                name: recId,
                format: "wav",
                beep: false,
                maxSilenceSeconds: 3, // Reducido de 5 a 3
                silenceThreshold: 256,
                ifExists: "overwrite",
                maxDuration: 10 // Máximo 10 segundos
            });

            log("info", `🎙️ [VB] Grabación iniciada: ${recId}`);

            let recordingFinished = false;

            const finishRecording = (result) => {
                if (!recordingFinished) {
                    recordingFinished = true;
                    resolve(result);
                }
            };

            recording.once("RecordingFinished", () => {
                log("info", `🎙️ [VB] Grabación finalizada: ${recId}.wav`);
                
                // Verificar que el archivo existe y tiene contenido
                setTimeout(() => {
                    if (fs.existsSync(wavFile) && fs.statSync(wavFile).size > 1000) {
                        log("debug", `📁 Archivo de grabación válido: ${fs.statSync(wavFile).size} bytes`);
                        finishRecording(wavFile);
                    } else {
                        log("error", `❌ Archivo de grabación inválido: ${wavFile}`);
                        finishRecording(null);
                    }
                }, 300);
            });

            // Timeout de seguridad
            setTimeout(() => {
                if (!recordingFinished) {
                    log("warn", `⏰ Timeout de grabación: ${recId}`);
                    recording.stop().catch(() => {});
                    finishRecording(null);
                }
            }, 11000);

        } catch (err) {
            log("error", `❌ Error en grabación: ${err.message}`);
            resolve(null);
        }
    });
}

export async function startVoiceBotSession(ari, channel, ani, dnis, linkedId) {
    log("info", `🤖 [VB ENGINE] Iniciando sesión ANI=${ani} DNIS=${dnis} LinkedId=${linkedId}`);
    log("info", `🔈 VoiceBot en modo direct-channel (sin bridge).`);

    let sessionActive = true;

    channel.on("StasisEnd", () => {
        log("info", `👋 [VB] Canal colgó, finalizando sesión.`);
        sessionActive = false;
    });

    channel.on("ChannelDestroyed", () => {
        log("info", `👋 [VB] Canal destruido.`);
        sessionActive = false;
    });

    // LOOP principal MEJORADO
    while (sessionActive) {
        const recId = `vb_${Date.now()}`;
        const processedUserWav = `${VOICEBOT_PATH}/${recId}_8k.wav`;

        // 1. Grabar audio del usuario
        const wavFile = await recordUserAudio(channel, recId);
        
        if (!wavFile || !sessionActive) {
            if (!wavFile) {
                log("warn", `🔄 Reintentando grabación...`);
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            break;
        }

        // 2. Convertir audio
        const conversionSuccess = await convertWavToWav8000(wavFile, processedUserWav);
        if (!conversionSuccess) {
            continue;
        }

        // 3. Procesar con OpenAI
        let responsePcm = null;
        try {
            responsePcm = await askRealtimeAndGetReply(processedUserWav);
        } catch (err) {
            log("error", `❌ [VB] OpenAI error: ${err.message}`);
            // Reproducir mensaje de error
            await playAudioToUser(ari, channel, "pbx-invalid");
            continue;
        }

        if (!responsePcm || !sessionActive) {
            break;
        }

        // 4. Procesar respuesta
        const rspId = `vb_rsp_${Date.now()}`;
        const rawPcmFile = `/var/spool/asterisk/recording/${rspId}.pcm`;
        const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

        try {
            fs.writeFileSync(rawPcmFile, responsePcm);

            // Convertir PCM → WAV compatible
            await execAsync(
                `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`
            );

            // Verificar que el archivo final existe
            if (!fs.existsSync(finalWavFile)) {
                throw new Error("Archivo WAV final no creado");
            }

            log("info", `✅ Archivo de respuesta creado: ${finalWavFile} (${fs.statSync(finalWavFile).size} bytes)`);

            // 5. Reproducir respuesta - ESPERAR a que termine
            const playbackSuccess = await playAudioToUser(ari, channel, rspId);
            
            if (!playbackSuccess) {
                log("error", `❌ Falló la reproducción de ${rspId}`);
                // Intentar beep de fallback
                await channel.play({ media: "sound:beep" }).catch(() => {});
            }

        } catch (err) {
            log("error", `❌ Error procesando respuesta: ${err.message}`);
            await channel.play({ media: "sound:beep" }).catch(() => {});
        } finally {
            // Limpiar archivos temporales
            try {
                if (fs.existsSync(rawPcmFile)) fs.unlinkSync(rawPcmFile);
                if (fs.existsSync(processedUserWav)) fs.unlinkSync(processedUserWav);
                if (fs.existsSync(wavFile)) fs.unlinkSync(wavFile);
            } catch (cleanupErr) {
                log("debug", `⚠️ Error limpiando archivos: ${cleanupErr.message}`);
            }
        }

        // Pequeña pausa entre interacciones
        await new Promise(r => setTimeout(r, 800));
    }

    log("info", `🔚 [VB] Sesión finalizada LinkedId=${linkedId}`);
}