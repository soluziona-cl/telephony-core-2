import WebSocket from "ws";
import fs from "fs";
import { log } from "../../../lib/logger.js";

/**
 * 🤖 Cliente para OpenAI Realtime API
 * Maneja la conexión WebSocket y los eventos de audio
 */
export class OpenAIRealtimeClient {
    constructor(config = {}) {
        this.apiKey = process.env.OPENAI_API_KEY;
        this.model = config.model || "gpt-4o-realtime-preview-2024-10-01";
        this.instructions = config.instructions || "Eres un asistente de voz amable y eficiente. Responde de manera clara y concisa.";
        this.voice = config.voice || "alloy"; // alloy, echo, shimmer
        this.language = config.language || "es"; // idioma de respuesta

        this.ws = null;
        this.isConnected = false;
        this.pendingResponses = new Map();
        this.currentConversation = [];
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
                    "Authorization": `Bearer ${this.apiKey}`,
                    "OpenAI-Beta": "realtime=v1"
                }
            });

            this.ws.on("open", () => {
                log("info", `✅ [OpenAI] Conectado a Realtime API`);
                this.isConnected = true;

                // Configurar sesión inicial
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

            // Escuchar eventos de OpenAI
            this.ws.on("message", (data) => {
                this.handleServerEvent(JSON.parse(data.toString()));
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
                turn_detection: null, // Manejamos turnos manualmente
                temperature: 0.8,
                max_response_output_tokens: 4096
            }
        };

        this.sendEvent(sessionConfig);
        log("info", `⚙️ [OpenAI] Sesión configurada: voice=${this.voice}`);
    }

    /**
     * 📤 Envía un evento al servidor OpenAI
     */
    sendEvent(event) {
        if (!this.isConnected || !this.ws) {
            log("warn", `⚠️ [OpenAI] No conectado, no se puede enviar evento`);
            return false;
        }

        this.ws.send(JSON.stringify(event));
        return true;
    }

    /**
     * 🎤 Envía audio del usuario a OpenAI
     * @param {Buffer} audioBuffer - Audio PCM16 en Buffer
     */
    async sendAudio(audioBuffer) {
        log("info", `🎤 [OpenAI] Enviando audio: ${audioBuffer.length} bytes`);

        // Convertir Buffer a base64
        const base64Audio = audioBuffer.toString("base64");

        // Enviar audio
        this.sendEvent({
            type: "input_audio_buffer.append",
            audio: base64Audio
        });

        // Crear respuesta y esperar resultado
        const responseId = `response_${Date.now()}`;

        return new Promise((resolve, reject) => {
            // Guardar promise para resolver cuando llegue la respuesta
            this.pendingResponses.set(responseId, { resolve, reject });

            // Solicitar respuesta
            this.sendEvent({
                type: "input_audio_buffer.commit"
            });

            this.sendEvent({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"]
                }
            });

            // Timeout de 30 segundos
            setTimeout(() => {
                if (this.pendingResponses.has(responseId)) {
                    this.pendingResponses.delete(responseId);
                    reject(new Error("Timeout esperando respuesta de OpenAI"));
                }
            }, 30000);
        });
    }

    /**
     * 📥 Maneja eventos del servidor OpenAI
     */
    handleServerEvent(event) {
        switch (event.type) {
            case "session.created":
                log("info", `✅ [OpenAI] Sesión creada: ${event.session.id}`);
                break;

            case "session.updated":
                log("info", `⚙️ [OpenAI] Sesión actualizada`);
                break;

            case "input_audio_buffer.speech_started":
                log("info", `🎤 [OpenAI] Detección de voz iniciada`);
                break;

            case "input_audio_buffer.speech_stopped":
                log("info", `🎤 [OpenAI] Detección de voz detenida`);
                break;

            case "input_audio_buffer.committed":
                log("info", `✅ [OpenAI] Audio del usuario procesado`);
                break;

            case "conversation.item.created":
                log("info", `💬 [OpenAI] Item creado: ${event.item.type}`);
                if (event.item.type === "message" && event.item.role === "user") {
                    const transcript = event.item.content?.[0]?.transcript;
                    if (transcript) {
                        log("info", `👤 [Usuario dijo]: "${transcript}"`);
                    }
                }
                break;

            case "response.audio_transcript.delta":
                // Transcripción en tiempo real de la respuesta
                log("debug", `🤖 [OpenAI] Transcripción delta: ${event.delta}`);
                break;

            case "response.audio_transcript.done":
                log("info", `🤖 [OpenAI dijo]: "${event.transcript}"`);
                break;

            case "response.audio.delta":
                // Audio de respuesta en chunks
                this.handleAudioDelta(event.delta);
                break;

            case "response.audio.done":
                log("info", `✅ [OpenAI] Audio de respuesta completo`);
                break;

            case "response.done":
                log("info", `✅ [OpenAI] Respuesta completada`);
                this.handleResponseDone(event.response);
                break;

            case "error":
                log("error", `❌ [OpenAI] Error: ${event.error.message}`);
                break;

            default:
                log("debug", `📩 [OpenAI] Evento: ${event.type}`);
        }
    }

    /**
     * 🔊 Maneja deltas de audio de la respuesta
     */
    handleAudioDelta(base64Delta) {
        if (!this.currentAudioChunks) {
            this.currentAudioChunks = [];
        }

        // Convertir base64 a Buffer
        const chunk = Buffer.from(base64Delta, "base64");
        this.currentAudioChunks.push(chunk);
    }

    /**
     * ✅ Maneja respuesta completada
     */
    handleResponseDone(response) {
        // Combinar todos los chunks de audio
        let audioBuffer = null;

        if (this.currentAudioChunks && this.currentAudioChunks.length > 0) {
            audioBuffer = Buffer.concat(this.currentAudioChunks);
            log("info", `🔊 [OpenAI] Audio total: ${audioBuffer.length} bytes`);
        }

        // Limpiar chunks
        this.currentAudioChunks = [];

        // Resolver promesa pendiente
        for (const [responseId, pending] of this.pendingResponses.entries()) {
            pending.resolve({
                audioBuffer,
                response
            });
            this.pendingResponses.delete(responseId);
            break; // Solo resolver la primera pendiente
        }
    }

    /**
     * 🔌 Cierra la conexión
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            this.isConnected = false;
            log("info", `🔌 [OpenAI] Desconectado manualmente`);
        }
    }
}

/**
 * 🎯 Función helper para usar en voicebot-engine.js
 */
export async function askRealtimeAndGetReply(wavFilePath, config = {}) {
    const client = new OpenAIRealtimeClient(config);

    try {
        // Conectar a OpenAI
        await client.connect();

        // Leer archivo WAV y convertir a PCM16
        const wavBuffer = fs.readFileSync(wavFilePath);
        const pcm16Buffer = await convertWavToPCM16(wavBuffer);

        // Enviar audio y esperar respuesta
        const result = await client.sendAudio(pcm16Buffer);

        // Desconectar
        client.disconnect();

        // Retornar audio en PCM16
        return result.audioBuffer;

    } catch (error) {
        log("error", `❌ [OpenAI] Error en conversación: ${error.message}`);
        client.disconnect();
        return null;
    }
}

/**
 * 🔄 Convierte WAV a PCM16 (16kHz, mono)
 */
async function convertWavToPCM16(wavBuffer) {
    const { spawn } = await import("child_process");
    const { randomUUID } = await import("crypto");

    const id = randomUUID();
    const wavPath = `/tmp/${id}.wav`;
    const pcmPath = `/tmp/${id}.pcm`;

    fs.writeFileSync(wavPath, wavBuffer);

    return new Promise((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
            "-y",
            "-i", wavPath,
            "-ar", "24000",  // 24kHz para OpenAI Realtime
            "-ac", "1",      // Mono
            "-f", "s16le",   // PCM16 little-endian
            pcmPath
        ]);

        ffmpeg.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`FFmpeg error code: ${code}`));
                return;
            }

            const pcmBuffer = fs.readFileSync(pcmPath);

            // Limpiar archivos temporales
            fs.unlinkSync(wavPath);
            fs.unlinkSync(pcmPath);

            resolve(pcmBuffer);
        });

        ffmpeg.stderr.on("data", (data) => {
            log("debug", `[FFmpeg] ${data.toString()}`);
        });
    });
}