/**
 * LEGACY HELPERS FOR VOICE ENGINE V3
 * (Moved from voice-engine.js for cleanup)
 * 
 * Contains standalone functions used by the legacy engine path.
 * These are gradually being replaced by modular components (ARI modules, Policies).
 */

import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { log } from "../../../../lib/logger.js";
import { inboundConfig as config } from "../config.js";
import { parseRutFromSpeech } from "../utils.js";

const execAsync = promisify(exec);

// CONSTANTS (Mirrored from voice-engine.js)
const VOICEBOT_PATH = config.paths.voicebot;
const ASTERISK_REC_PATH = config.paths.recordings;
const MAX_WAIT_MS = config.audio.maxWaitMs || 4000;
const MIN_TALKING_EVENT = config.audio.minTalkingEvents || 3;
// 🎯 MEJORA FLUIDEZ: Usar valor de config (150ms) en lugar de 300ms por defecto
const TALKING_DEBOUNCE_MS = config.audio.talkingDebounceMs || 150;
const PLAYBACK_TIMEOUT_MS = config.audio.playbackTimeoutMs || 30000;
const SILENCE_THRESHOLD_SEC = config.audio.maxSilenceSeconds || 2;
const MAX_RECORDING_MS = config.audio.maxRecordingMs || 15000;

// =========================================================
// HELPER FUNCTIONS
// =========================================================

export async function waitForFile(path, timeoutMs = 3000, intervalMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fs.existsSync(path)) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

export async function waitForRealVoice(channel, {
    maxWaitMs = MAX_WAIT_MS,
    minTalkingEvents = MIN_TALKING_EVENT,
    postPlaybackGuardMs = 0,
    lastPlaybackEnd = 0,
    checkDeltaEvidence = null // 🎯 NUEVO: Callback para verificar evidencia de deltas
} = {}) {
    // 🛡️ Verificar canal antes de suscribir listeners
    try {
        const alive = await channel.get();
        if (!alive || alive.state === 'Down') {
            log("debug", `[VAD] Canal down, aborting wait`);
            return false;
        }
    } catch (err) {
        return false;
    }

    return new Promise((resolve) => {
        let talkingEvents = 0;
        let finished = false;
        let timer = null;
        let deltaCheckInterval = null; // 🎯 NUEVO: Interval para verificar deltas

        const handler = (event, chan) => {
            // Filtrar evento para el canal correcto
            if (!chan || chan.id !== channel.id) return;

            talkingEvents++;

            // 🛡️ PLAYBACK GUARD
            if (lastPlaybackEnd > 0) {
                const timeSincePlayback = Date.now() - lastPlaybackEnd;
                if (timeSincePlayback < postPlaybackGuardMs) {
                    log("debug", `🛡️ [VAD] Ignorando voz durante guard time (${timeSincePlayback}ms < ${postPlaybackGuardMs}ms)`);
                    return;
                }
            }

            //log("debug", `🗣️ [VAD] Voz detectada (${talkingEvents}/${minTalkingEvents})`);

            if (talkingEvents >= minTalkingEvents) {
                //log("info", `✅ [VAD] Voz humana confirmada tras ${talkingEvents} eventos`);
                cleanup();
                resolve(true); // Se detectó voz humana real
            }
        };

        // 🎯 NUEVO: Verificar evidencia de deltas periódicamente durante la espera
        if (checkDeltaEvidence && typeof checkDeltaEvidence === 'function') {
            deltaCheckInterval = setInterval(async () => {
                if (finished) return;
                
                const hasEvidence = await checkDeltaEvidence();
                if (hasEvidence) {
                    log("info", `🎤 [VAD HÍBRIDO] Voz detectada por deltas durante waitForRealVoice`);
                    cleanup();
                    resolve(true); // Se detectó voz por deltas
                }
            }, 300); // Verificar cada 300ms (balance entre latencia y carga)
        }

        const cleanup = () => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            if (deltaCheckInterval) clearInterval(deltaCheckInterval);
            channel.removeListener("ChannelTalkingStarted", handler);
        };

        channel.on("ChannelTalkingStarted", handler);

        timer = setTimeout(() => {
            if (finished) return;
            //log("debug", `⏰ [VAD] Timeout waiting for voice (${maxWaitMs}ms)`);
            cleanup();
            resolve(false); // Silencio (no se detectó suficiente voz)
        }, maxWaitMs);
    });
}

export function isValidRecording(wavPath) {
    try {
        const stats = fs.statSync(wavPath);
        // FILTRO CRÍTICO: Ignorar audios menores a 6KB (WebRTC noise / micro-turns)
        if (stats.size < 3000) {
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

export async function convertWavToWav8000(inputWav, outputWav) {
    try {
        const cmd = `ffmpeg -y -i "${inputWav}" -ar 8000 -ac 1 -codec:a pcm_mulaw "${outputWav}"`;
        log("debug", `[FFmpeg] ${cmd}`);
        await execAsync(cmd);
    } catch (err) {
        throw new Error(`FFmpeg conversion failed: ${err.message}`);
    }
}

export async function playWithBargeIn(ari, channel, fileBaseName, openaiClient, options = {}, voiceBridgeRef = null) {
    // 🛡️ Protección básica
    if (!channel || !channel.id || !fileBaseName) {
        log("warn", `⚠️ [PLAYBACK] Parámetros inválidos, omitiendo playback`);
        if (openaiClient) openaiClient.isPlaybackActive = false;
        return { reason: "invalid_params" };
    }

    // 🛡️ Protección: Verificar que el canal existe antes de reproducir
    try {
        const channelState = await channel.get();
        if (!channelState || channelState.state === 'Down') {
            log("warn", `🔇 [VB V3] Canal no disponible para playback (estado: ${channelState?.state || 'null'}), omitiendo`);
            if (openaiClient) openaiClient.isPlaybackActive = false;
            return { reason: "channel_down", skipped: true };
        }
    } catch (err) {
        if (err.message && (err.message.includes('Channel not found') || err.message.includes('404'))) {
            log("warn", `🔇 [VB V3] Canal ${channel.id} ya no existe (hangup temprano), omitiendo playback`);
        } else {
            log("warn", `🔇 [VB V3] No se pudo verificar estado del canal: ${err.message}, omitiendo playback`);
        }
        if (openaiClient) openaiClient.isPlaybackActive = false;
        return { reason: "channel_not_found", skipped: true };
    }

    const allowBargeIn = options.bargeIn !== false;
    const media = `sound:voicebot/${fileBaseName}`;

    log("info", `🔊 [VB V3] Reproduciendo (barge-in ${allowBargeIn ? 'si' : 'no'}): ${media}`);
    if (openaiClient) {
        openaiClient.isPlaybackActive = true;
        log("info", "🔇 [STT] Pausado por inicio de playback");
    }

    return new Promise((resolve) => {
        let bargedIn = false;
        let finished = false;
        let talkingTimer = null;
        let playbackInstance = null; // Se asignará según bridge o channel
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

                if (playbackInstance) {
                    playbackInstance.stop().catch((err) =>
                        log("warn", `⚠️ Error deteniendo playback: ${err.message}`)
                    );
                }
            }, TALKING_DEBOUNCE_MS);
        };

        const cleanup = () => {
            finished = true;
            if (talkingTimer) clearTimeout(talkingTimer);
            channel.removeListener("ChannelTalkingStarted", talkingHandler);
        };

        const registerPlaybackListeners = (playbackObj) => {
            const playbackStartTime = Date.now();
            // 🎯 FIX: Considerar bridge.play() como START confirmado (ARI a veces no emite PlaybackStarted)
            // Si playbackObj ya tiene un ID, significa que bridge.play() retornó exitosamente = started
            let playbackStartedReceived = playbackObj?.id ? true : false;
            
            if (playbackStartedReceived) {
                log("info", `🎵 [PLAYBACK] PlaybackStarted confirmado por bridge.play() exitoso (playbackId=${playbackObj.id})`);
            }
            
            playbackObj.on("PlaybackStarted", () => {
                playbackStartedReceived = true;
                const timeToStart = Date.now() - playbackStartTime;
                log("info", `🎵 [PLAYBACK] PlaybackStarted recibido para ${media} (tiempo hasta inicio: ${timeToStart}ms)`);
            });
            
            playbackObj.on("PlaybackFinished", () => {
                if (finished) return;
                const duration = Date.now() - playbackStartTime;
                if (openaiClient) {
                    openaiClient.isPlaybackActive = false;
                    log("info", "🎧 [STT] Reanudado tras playback");
                }
                
                // 🛡️ DETECCIÓN CRÍTICA: Playback completado sin iniciar o demasiado rápido
                // 🎯 FIX: Usar playback.id como referencia (no mediaPath)
                const playbackId = playbackObj?.id || 'unknown';
                if (!playbackStartedReceived) {
                    log("error", `❌ [PLAYBACK] PlaybackFinished recibido SIN PlaybackStarted para ${media} (playbackId=${playbackId}) - archivo no encontrado o bridge mal configurado`);
                } else if (duration < 100) {
                    log("warn", `⚠️ [PLAYBACK] Playback completado demasiado rápido (${duration}ms) - posible archivo vacío o corrupto`);
                } else {
                    log("info", `✅ Playback completado: ${media} (duración: ${duration}ms, playbackId=${playbackId})`);
                }
                cleanup();
                resolve({ reason: bargedIn ? "barge-in" : "finished" });
            });

            playbackObj.on("PlaybackStopped", () => {
                if (finished) return;
                const duration = Date.now() - playbackStartTime;
                if (openaiClient) {
                    openaiClient.isPlaybackActive = false;
                    log("info", "🎧 [STT] Reanudado tras playback (stopped)");
                }
                log("debug", `🛑 Playback detenido: ${media} (duración: ${duration}ms)`);
                cleanup();
                resolve({ reason: bargedIn ? "barge-in" : "stopped" });
            });

            playbackObj.on("PlaybackFailed", (evt) => {
                if (finished) return;
                const duration = Date.now() - playbackStartTime;
                if (openaiClient) {
                    openaiClient.isPlaybackActive = false;
                    log("info", "🎧 [STT] Reanudado tras playback (failed)");
                }
                
                // 🔍 DIAGNÓSTICO DETALLADO: El evento puede contener información sobre por qué falló
                const errorDetails = {
                    media: media,
                    duration: `${duration}ms`,
                    event: evt,
                    startedReceived: playbackStartedReceived,
                    possibleCauses: []
                };
                
                if (!playbackStartedReceived) {
                    errorDetails.possibleCauses.push("Archivo de audio no encontrado en Asterisk");
                }
                if (duration < 50) {
                    errorDetails.possibleCauses.push("Playback falló inmediatamente - posible problema de permisos o formato");
                }
                
                log("error", `❌ [PLAYBACK] Playback falló: ${JSON.stringify(errorDetails)}`);
                cleanup();
                resolve({ reason: "failed" });
            });
        };

        channel.on("ChannelTalkingStarted", talkingHandler);

        const timeoutTimer = setInterval(() => {
            if (finished) {
                clearInterval(timeoutTimer);
                return;
            }
            if (Date.now() - startedAt > PLAYBACK_TIMEOUT_MS) {
                log("warn", `⏰ Timeout en playback: ${media}`);
                if (playbackInstance) {
                    playbackInstance.stop().catch((err) =>
                        log("warn", `⚠️ Error timeout playback: ${err.message}`)
                    );
                }
                clearInterval(timeoutTimer);
            }
        }, 500);

        // 🎯 VERDAD ARQUITECTÓNICA: Si existe Voice Bridge, el playback DEBE ir por el bridge
        const startPlayback = async () => {
            try {
                if (voiceBridgeRef?.current) {
                    // 🛡️ CRÍTICO: Verificar que el bridge tenga canales antes de reproducir
                    const bridgeInfo = await voiceBridgeRef.current.get();
                    const hasChannels = Array.isArray(bridgeInfo.channels) && bridgeInfo.channels.length > 0;
                    
                    // 🔍 INFO level para diagnóstico forense (siempre visible)
                    log("info", `🔍 [PLAYBACK] Bridge ${voiceBridgeRef.current.id} estado: channels=${bridgeInfo.channels?.length || 0}, bridgeType=${bridgeInfo.bridge_type || 'unknown'}, bridgeClass=${bridgeInfo.bridge_class || 'unknown'}`);
                    
                    if (!hasChannels) {
                        log("warn", `⚠️ [PLAYBACK] Bridge ${voiceBridgeRef.current.id} no tiene canales, usando channel.play() como fallback`);
                        // Fallback a canal si el bridge está vacío
                        const channelPlayback = ari.Playback();
                        playbackInstance = channelPlayback;
                        registerPlaybackListeners(channelPlayback);
                        await channel.play({ media }, channelPlayback);
                        return;
                    }
                    
                    log("info", `🔊 [PLAYBACK] Bridge.play (${voiceBridgeRef.current.id}, channels: ${bridgeInfo.channels.length}) → ${media}`);
                    // bridge.play() devuelve un objeto Playback, no acepta uno como parámetro
                    try {
                        playbackInstance = await voiceBridgeRef.current.play({ media });
                        
                        // 🛡️ VALIDACIÓN CRÍTICA: Verificar que el playback se creó correctamente
                        if (!playbackInstance) {
                            log("error", `❌ [PLAYBACK] bridge.play() retornó null/undefined para ${media}`);
                            throw new Error("Playback instance is null");
                        }
                        
                    log("info", `✅ [PLAYBACK] Bridge.play iniciado, playbackId=${playbackInstance.id || 'unknown'}, media=${media}`);
                    
                    // Registrar listeners (maneja PlaybackStarted, PlaybackFinished, etc.)
                    // 🎯 FIX: Registrar listeners DESPUÉS de que bridge.play() retorna (playbackInstance ya tiene ID)
                    registerPlaybackListeners(playbackInstance);
                    
                    // 🎯 FIX ADICIONAL: Si playbackInstance.id existe, marcar como started inmediatamente
                    // Esto asegura que el flag esté set antes de que llegue cualquier evento
                    if (playbackInstance.id) {
                        log("info", `🎵 [PLAYBACK] PlaybackStarted confirmado por bridge.play() exitoso (playbackId=${playbackInstance.id})`);
                    }
                    } catch (playErr) {
                        log("error", `❌ [PLAYBACK] Error en bridge.play(): ${playErr.message}, stack: ${playErr.stack}`);
                        throw playErr; // Re-lanzar para que el catch externo lo maneje
                    }
                } else {
                    // Fallback legacy (backward compatibility)
                    log("info", `🔊 [PLAYBACK] Channel.play (legacy) → ${media}`);
                    const channelPlayback = ari.Playback();
                    playbackInstance = channelPlayback;
                    registerPlaybackListeners(channelPlayback);
                    await channel.play({ media }, channelPlayback);
                }
            } catch (err) {
                // 🧯 Fallback duro por seguridad operativa
                if (finished) return;
                log("warn", `⚠️ [PLAYBACK] Bridge.play falló, usando channel.play(): ${err.message}`);
                try {
                    const channelPlayback = ari.Playback();
                    playbackInstance = channelPlayback;
                    registerPlaybackListeners(channelPlayback);
                    await channel.play({ media }, channelPlayback);
                } catch (fallbackErr) {
                    log("error", `❌ No se pudo iniciar playback: ${fallbackErr.message}`);
                    cleanup();
                    resolve({ reason: "error" });
                }
            }
        };

        startPlayback().catch((err) => {
            if (finished) return;
            log("error", `❌ Error iniciando playback: ${err.message}`);
            cleanup();
            resolve({ reason: "error" });
        });
    });
}

export async function recordUserTurn(channel, turnNumber) {
    const recId = `vb_${Date.now()}`;
    const wavFile = `${ASTERISK_REC_PATH}/${recId}.wav`;

    log("info", `🎙️ [VB V3] Iniciando grabación turno #${turnNumber}: ${recId}`);

    if (config.engine.ENABLE_TURN_RECORDING === false) {
        log("info", `🎙️ [VB V3] Grabación desactivada por config (ENABLE_TURN_RECORDING=false)`);
        // Return dummy success so engine flow continues
        return { ok: true, reason: "disabled", path: null, recId };
    }

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

    //log("info", `✅ Grabación válida: ${wavFile} (${result.duration}s)`);
    return { ok: true, reason: "ok", path: wavFile, recId };
}

export function extractRutCandidate(transcript = "") {
    if (!transcript) return { body: null, dv: null, allDigits: "" };

    const parsed = parseRutFromSpeech(transcript);
    const allDigits = parsed.body ? (parsed.body + (parsed.dv || "")) : "";

    return {
        body: parsed.body ? String(parsed.body) : null,
        dv: parsed.dv || null,
        allDigits: allDigits,
        reason: parsed.reason,
        ok: parsed.ok
    };
}

export function rutExpectedDV(body) {
    const s = body.split("").reverse().map(Number);
    const factors = [2, 3, 4, 5, 6, 7];
    let sum = 0;
    for (let i = 0; i < s.length; i++) sum += s[i] * factors[i % factors.length];
    const mod = 11 - (sum % 11);
    if (mod === 11) return "0";
    if (mod === 10) return "k";
    return String(mod);
}

export async function processUserTurnWithOpenAI(userWavPath, openaiClient) {
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

export async function playGreeting(ari, channel, openaiClient, botConfig = {}, conversationState = null) {
    log("info", "👋 [VB V3] Preparando saludo inicial...");

    const defaultGreeting = "Hola, Bienvenido.";
    let greetingText = botConfig.greetingText || defaultGreeting;

    if (botConfig.greetingFile) {
        const staticFileName = botConfig.greetingFile;
        const staticFilePath = `${VOICEBOT_PATH}/${staticFileName}.wav`;

        if (fs.existsSync(staticFilePath)) {
            log('info', `📂 [STATIC] Usando saludo estático: ${staticFileName}.wav`);
            await playWithBargeIn(ari, channel, staticFileName, openaiClient, { bargeIn: false });

            if (conversationState) {
                conversationState.history.push({ role: 'assistant', content: greetingText });
            }

            await new Promise(r => setTimeout(r, 300)); // Pausa de confort
            return true;
        } else {
            log('warn', `⚠️ [STATIC] Archivo no encontrado: ${staticFilePath}, generando con IA...`);
        }
    }

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

        await playWithBargeIn(ari, channel, rspId, openaiClient, { bargeIn: false });

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

export async function playStillTherePrompt(ari, channel, openaiClient) {
    log("info", `❓ [VB V3] Reproduciendo prompt estático: ¿Sigue en línea?`);

    try {
        if (channel) {
            await channel.play({ media: 'sound:silence/1' });
        }

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

        await playWithBargeIn(ari, channel, rspId, openaiClient, { bargeIn: false });
        await new Promise(r => setTimeout(r, 600));

        log("info", "✅ Prompt estático '¿Sigue en línea?' completado");
        return true;

    } catch (err) {
        log("error", `❌ Error en prompt estático '¿Sigue en línea?': ${err.message}`);
        return false;
    }
}

export async function sendSystemTextAndPlay(ari, channel, openaiClient, text, options = {}, voiceBridgeRef = null) {
    try {
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

        await playWithBargeIn(ari, channel, rspId, openaiClient, options, voiceBridgeRef);
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

export async function sendBvdaText(ari, channel, openaiClient, text) {
    log("info", `🛡️ [BVDA] Enviando mensaje protegido (no barge-in): ${text.slice(0, 50)}...`);
    return sendSystemTextAndPlay(ari, channel, openaiClient, text, { bargeIn: false });
}

export async function transferToQueue(ari, channel, queueName = "cola_ventas") {
    log("info", `📞 [VB V3] INICIANDO Transferencia a cola: ${queueName}`);
    const channelId = channel.id;
    const channelState = channel.state;
    const linkedId = channel.linkedid;

    log("debug", `🔍 [Transferencia] Canal ID: ${channelId}, Estado: ${channelState}, LinkedId: ${linkedId}`);

    try {
        log("info", `🔄 [Transferencia] Redirigiendo a contexto: queues, extensión: ${queueName}`);

        await channel.continueInDialplan({
            context: 'queues',
            extension: queueName,
            priority: 1
        });

        log("info", `✅ [Transferencia] Comando continueInDialplan enviado.`);
    } catch (err) {
        log("error", `❌ [Transferencia] Falló: ${err.message}`);
    }
}

export function shouldTransferToQueue(transcript, assistantResponse = "") {
    if (!transcript) {
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
        const regex = new RegExp(`\\b${keyword}\\b`, "i");
        return regex.test(lowerTranscript);
    });

    if (detected) {
        log("info", `🎯 [Transferencia] Palabra clave detectada: "${transcript}"`);
    }

    return detected;
}

export function shouldEndCall(text) {
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
