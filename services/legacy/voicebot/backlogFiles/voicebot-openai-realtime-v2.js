// voicebot-openai-realtime_v2.js
import WebSocket from "ws";
import fs from "fs";
import { log } from "../../../lib/logger.js";

/**
 * 🤖 Cliente para OpenAI Realtime API (v2)
 * - Manejo de silencio (no envía audio vacío o muy corto)
 * - Soporte para barge-in (cancelar respuesta en curso)
 * - Instrucciones mejoradas para contexto telefónico
 * - Sin logs de delta por defecto, solo transcript final
 */
export class OpenAIRealtimeClientV2 {
    constructor(config = {}) {
        this.apiKey = process.env.OPENAI_API_KEY;
        this.model = config.model || "gpt-4o-realtime-preview-2024-10-01";

        // Instrucciones más específicas para uso como voicebot telefónico
        this.instructions =
            config.instructions ||
            [
                "Eres un asistente de voz telefónico amable y eficiente.",
                "Hablas en español latino neutro.",
                "Responde de forma breve, clara y natural, como si hablaras por teléfono.",
                "No des explicaciones técnicas ni menciones APIs.",
                "Si el usuario guarda silencio, puedes hacer una pregunta corta de seguimiento.",
                "Evita respuestas largas; prioriza frases cortas y directas."
            ].join(" ");

        this.voice = config.voice || "alloy"; // alloy, echo, shimmer
        this.language = config.language || "es";

        // Manejo de silencio: mínimo de audio útil antes de enviar a OpenAI
        this.minAudioMs = config.minAudioMs ?? 150; // ms mínimos de audio para procesar
        this.sampleRate = 24000; // 24 kHz para Realtime
        this.minAudioBytes =
            config.minAudioBytes ??
            Math.floor((this.sampleRate * 2 * this.minAudioMs) / 1000); // 2 bytes por muestra (PCM16)

        // Logging de deltas (desactivado por defecto)
        this.logPartialTranscripts = config.logPartialTranscripts ?? false;

        this.ws = null;
        this.isConnected = false;

        // Mapa de respuestas pendientes (promises)
        this.pendingResponses = new Map();
        this.currentAudioChunks = [];

        // Para barge-in / cancelación
        this.activeResponseId = null;
    }

    /**
     * 🔌 Conecta al WebSocket de OpenAI Realtime API
     */
    async connect() {
        return new Promise((resolve, reject) => {
            const url = `wss://api.openai.com/v1/realtime?model=${this.model}`;

            log("info", `🔌 [OpenAI] Conectando a Realtime API...`);

            this.ws = new WebSocket(url, {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "OpenAI-Beta": "realtime=v1"
                }
            });

            this.ws.on("open", () => {
                log("info", `✅ [OpenAI] Conectado a Realtime API`);
                this.isConnected = true;

                this.updateSession();
                resolve();
            });

            this.ws.on("error", (error) => {
                log("error", `❌ [OpenAI] Error WebSocket: ${error.message}`);
                this.isConnected = false;
                reject(error);
            });

            this.ws.on("close", () => {
                log("info", `🔌 [OpenAI] Desconectado`);
                this.isConnected = false;
            });

            this.ws.on("message", (data) => {
                try {
                    const event = JSON.parse(data.toString());
                    this.handleServerEvent(event);
                } catch (err) {
                    log("error", `❌ [OpenAI] Error parseando mensaje WS: ${err.message}`);
                }
            });
        });
    }

    /**
     * ⚙️ Actualiza la configuración de la sesión
     */
    updateSession() {
        const sessionConfig = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                instructions: this.instructions,
                voice: this.voice,
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                input_audio_transcription: {
                    model: "whisper-1"
                },
                // Manejamos turnos desde Asterisk / voicebot-engine
                turn_detection: null,
                temperature: 0.6,
                max_response_output_tokens: 512
            }
        };

        this.sendEvent(sessionConfig);
        log("info", `⚙️ [OpenAI] Sesión configurada: voice=${this.voice}`);
    }

    /**
     * 📤 Envía un evento al servidor
     */
    sendEvent(event) {
        if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            log("warn", `⚠️ [OpenAI] No conectado, no se puede enviar evento: ${event?.type}`);
            return false;
        }

        this.ws.send(JSON.stringify(event));
        return true;
    }

    /**
     * 🎤 Envía audio del usuario a OpenAI
     * @param {Buffer} audioBuffer - Audio PCM16 (mono, 24kHz)
     */
    async sendAudio(audioBuffer) {
        if (!audioBuffer || audioBuffer.length === 0) {
            log("warn", "⚠️ [OpenAI] Buffer de audio vacío, no se envía nada");
            return null;
        }

        if (audioBuffer.length < this.minAudioBytes) {
            log(
                "warn",
                `⚠️ [OpenAI] Audio demasiado corto (${audioBuffer.length} bytes). ` +
                    `Mínimo requerido: ${this.minAudioBytes} bytes (~${this.minAudioMs}ms).`
            );
            return null;
        }

        log("info", `🎤 [OpenAI] Enviando audio: ${audioBuffer.length} bytes`);

        const base64Audio = audioBuffer.toString("base64");

        this.sendEvent({
            type: "input_audio_buffer.append",
            audio: base64Audio
        });

        // ID lógico interno para esta respuesta
        const responseKey = `response_${Date.now()}`;

        return new Promise((resolve, reject) => {
            this.pendingResponses.set(responseKey, { resolve, reject });

            // Commit del buffer e inicio de generación
            this.sendEvent({
                type: "input_audio_buffer.commit"
            });

            this.sendEvent({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"]
                }
            });

            // Timeout de seguridad
            setTimeout(() => {
                if (this.pendingResponses.has(responseKey)) {
                    this.pendingResponses.delete(responseKey);
                    reject(new Error("Timeout esperando respuesta de OpenAI"));
                }
            }, 30000);
        });
    }

    /**
     * 📥 Manejo de eventos del servidor OpenAI
     */
    handleServerEvent(event) {
        switch (event.type) {
            case "session.created":
                log("info", `✅ [OpenAI] Sesión creada: ${event.session.id}`);
                break;

            case "session.updated":
                log("info", "⚙️ [OpenAI] Sesión actualizada");
                break;

            case "input_audio_buffer.speech_started":
                log("debug", "🎤 [OpenAI] Detección de voz iniciada");
                break;

            case "input_audio_buffer.speech_stopped":
                log("debug", "🎤 [OpenAI] Detección de voz detenida");
                break;

            case "input_audio_buffer.committed":
                log("info", "✅ [OpenAI] Audio del usuario procesado");
                break;

            case "conversation.item.created": {
                const item = event.item;
                if (item.type === "message" && item.role === "user") {
                    const transcript = item.content?.[0]?.transcript;
                    if (transcript) {
                        log("info", `👤 [Usuario dijo]: "${transcript}"`);
                    }
                }
                break;
            }

            case "response.created":
                // Guardamos el id de la respuesta actual para poder cancelarla (barge-in)
                this.activeResponseId = event.response?.id || null;
                log("debug", `📩 [OpenAI] response.created id=${this.activeResponseId}`);
                break;

            case "response.audio_transcript.delta":
                // Solo log si se habilita explícitamente
                if (this.logPartialTranscripts) {
                    log("debug", `🤖 [OpenAI] Transcripción delta: ${event.delta}`);
                }
                break;

            case "response.audio_transcript.done":
                // Transcript final de la respuesta
                log("info", `🤖 [OpenAI dijo]: "${event.transcript}"`);
                break;

            case "response.audio.delta":
                this.handleAudioDelta(event.delta);
                break;

            case "response.audio.done":
                log("debug", "✅ [OpenAI] Audio de respuesta completo");
                break;

            case "response.done":
                log("info", "✅ [OpenAI] Respuesta completada");
                this.handleResponseDone(event.response);
                // Limpiamos el id activo
                this.activeResponseId = null;
                break;

            case "error":
                log("error", `❌ [OpenAI] Error: ${event.error?.message}`);
                break;

            default:
                // Para reducir ruido, dejamos esto en debug
                log("debug", `📩 [OpenAI] Evento: ${event.type}`);
        }
    }

    /**
     * 🔊 Maneja deltas de audio
     */
    handleAudioDelta(base64Delta) {
        if (!this.currentAudioChunks) {
            this.currentAudioChunks = [];
        }
        const chunk = Buffer.from(base64Delta, "base64");
        this.currentAudioChunks.push(chunk);
    }

    /**
     * ✅ Completa una respuesta y resuelve la promesa pendiente
     */
    handleResponseDone(response) {
        let audioBuffer = null;

        if (this.currentAudioChunks && this.currentAudioChunks.length > 0) {
            audioBuffer = Buffer.concat(this.currentAudioChunks);
            log("info", `🔊 [OpenAI] Audio total: ${audioBuffer.length} bytes`);
        }

        this.currentAudioChunks = [];

        // Resolver la primera promesa pendiente
        for (const [key, pending] of this.pendingResponses.entries()) {
            pending.resolve({
                audioBuffer,
                response
            });
            this.pendingResponses.delete(key);
            break;
        }
    }

    /**
     * ⛔ Cancelar la respuesta actual (para barge-in)
     * Llamar desde voicebot-engine cuando el usuario interrumpe al bot.
     */
    cancelCurrentResponse(reason = "user_barge_in") {
        if (!this.activeResponseId) {
            log("debug", "ℹ️ [OpenAI] No hay respuesta activa para cancelar");
            return;
        }

        log("info", `⛔ [OpenAI] Cancelando respuesta activa (${this.activeResponseId}) por: ${reason}`);

        // Cancelar respuesta en curso
        this.sendEvent({
            type: "response.cancel",
            response_id: this.activeResponseId
        });

        // Limpiar cualquier audio pendiente en el buffer de entrada
        this.sendEvent({
            type: "input_audio_buffer.clear"
        });

        this.activeResponseId = null;
        this.currentAudioChunks = [];
    }

    /**
     * 🔌 Cerrar conexión
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            this.isConnected = false;
            log("info", "🔌 [OpenAI] Desconectado manualmente");
        }
    }
}

/**
 * 🎯 Helper para usar desde voicebot-engine.js (v2)
 * - Lee WAV
 * - Convierte a PCM16 24kHz mono
 * - Envía a Realtime
 * - Devuelve Buffer PCM16 de la respuesta (o null)
 */
export async function askRealtimeAndGetReplyV2(wavFilePath, config = {}) {
    const client = new OpenAIRealtimeClientV2(config);

    try {
        await client.connect();

        const wavBuffer = fs.readFileSync(wavFilePath);
        const pcm16Buffer = await convertWavToPCM16_24k(wavBuffer);

        const result = await client.sendAudio(pcm16Buffer);

        client.disconnect();

        if (!result) return null;

        return result.audioBuffer;
    } catch (error) {
        log("error", `❌ [OpenAI] Error en conversación (v2): ${error.message}`);
        client.disconnect();
        return null;
    }
}

/**
 * 🔄 Convierte WAV a PCM16 (24kHz, mono) usando ffmpeg
 */
async function convertWavToPCM16_24k(wavBuffer) {
    const { spawn } = await import("child_process");
    const { randomUUID } = await import("crypto");

    const id = randomUUID();
    const wavPath = `/tmp/${id}.wav`;
    const pcmPath = `/tmp/${id}.pcm`;

    fs.writeFileSync(wavPath, wavBuffer);

    return new Promise((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
            "-y",
            "-i",
            wavPath,
            "-ar",
            "24000", // 24 kHz
            "-ac",
            "1", // mono
            "-f",
            "s16le",
            pcmPath
        ]);

        ffmpeg.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`FFmpeg error code: ${code}`));
                return;
            }

            try {
                const pcmBuffer = fs.readFileSync(pcmPath);
                fs.unlinkSync(wavPath);
                fs.unlinkSync(pcmPath);
                resolve(pcmBuffer);
            } catch (err) {
                reject(err);
            }
        });

        ffmpeg.stderr.on("data", (data) => {
            log("debug", `[FFmpeg] ${data.toString()}`);
        });
    });
}
