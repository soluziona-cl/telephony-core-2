// =========================================================
// OPENAI REALTIME CLIENT V3 - Ultra-Low Latency
// =========================================================
// ✅ Sesión persistente (sin reconectar cada turno)
// ✅ Soporte para entrada de texto (para saludos)
// ✅ Respuestas cortas y naturales
// ✅ Barge-in con cancelación inmediata
// =========================================================

import WebSocket from "ws";
import fs from "fs";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { log } from "../../lib/logger.js";
import config from "./voicebot.config.js";

export class OpenAIRealtimeClientV3 {
  constructor(custom = {}) {
    const cfg = config.openai;

    this.apiKey = process.env.OPENAI_API_KEY;
    this.model = custom.model || cfg.model;

    this.instructions = custom.instructions || cfg.instructions;
    this.voice = custom.voice || cfg.voice;
    this.language = custom.language || cfg.language;

    this.temperature = cfg.temperature;
    this.maxTokens = cfg.maxResponseTokens;

    this.minAudioMs = cfg.minAudioMs;
    this.sampleRate = 24000;
    this.minAudioBytes = Math.floor((this.sampleRate * 2 * this.minAudioMs) / 1000);

    this.logPartialTranscripts = cfg.logPartialTranscripts;

    this.ws = null;
    this.isConnected = false;

    this.pendingResponses = new Map();
    this.currentAudioChunks = [];

    // Para barge-in
    this.activeResponseId = null;

    // Para capturar transcripts
    this.lastTranscript = "";
    this.lastAssistantResponse = "";

    // Para capturar transcripts
    this.lastTranscript = "";
    this.lastAssistantResponse = "";
  }

  /**
   * 🔌 Conectar al WebSocket
   */
  async connect() {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${this.model}`;

      log("info", `🔌 [OpenAI V3] Conectando a Realtime API...`);

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1"
        }
      });

      this.ws.on("open", () => {
        log("info", `✅ [OpenAI V3] Conectado`);
        this.isConnected = true;
        this.updateSession();
        resolve();
      });

      this.ws.on("error", (error) => {
        log("error", `❌ [OpenAI V3] WebSocket error: ${error.message}`);
        this.isConnected = false;
        reject(error);
      });

      this.ws.on("close", () => {
        log("info", `🔌 [OpenAI V3] Desconectado`);
        this.isConnected = false;
      });

      this.ws.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleServerEvent(event);
        } catch (err) {
          log("error", `❌ [OpenAI V3] Error parseando mensaje: ${err.message}`);
        }
      });
    });
  }

  /**
   * ⚙️ Actualizar configuración de sesión
   */
  updateSession() {
    const cfg = config.openai;

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
        turn_detection: null,
        temperature: cfg.temperature,
        max_response_output_tokens: cfg.maxResponseTokens
      }
    };

    this.sendEvent(sessionConfig);
    log("info", `⚙️ [OpenAI V3] Sesión configurada: voice=${this.voice}`);
  }

  /**
   * 📤 Enviar evento
   */
  sendEvent(event) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log("warn", `⚠️ [OpenAI V3] No conectado, no se puede enviar: ${event?.type}`);
      return false;
    }

    this.ws.send(JSON.stringify(event));
    return true;
  }

  /**
   * 💬 Enviar texto y esperar respuesta de audio
   * @param {string} text - Texto del usuario
   * @returns {Promise<Buffer>} - PCM16 24kHz de la respuesta
   */
  async sendTextAndWait(text) {
    log("info", `💬 [OpenAI V3] Enviando texto: "${text}"`);

    // Limpiar chunks anteriores
    this.currentAudioChunks = [];

    // Crear item de conversación con texto
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: text
          }
        ]
      }
    });

    // Crear promesa para respuesta
    const responseKey = `text_response_${Date.now()}`;

    const responsePromise = new Promise((resolve, reject) => {
      this.pendingResponses.set(responseKey, { resolve, reject });

      // Timeout
      setTimeout(() => {
        if (this.pendingResponses.has(responseKey)) {
          this.pendingResponses.delete(responseKey);
          reject(new Error("Timeout esperando respuesta de OpenAI"));
        }
      }, 30000);
    });

    // Solicitar respuesta (audio + text)
    this.sendEvent({
      type: "response.create",
      response: {
        modalities: ["text", "audio"]
      }
    });

    const result = await responsePromise;
    return result.audioBuffer;
  }

  /**
   * 🎤 Enviar audio y esperar respuesta
   * @param {string} wavFilePath - Ruta al archivo WAV 8kHz
   * @returns {Promise<Buffer>} - PCM16 24kHz de la respuesta
   */
  async sendAudioAndWait(wavFilePath) {
    if (!fs.existsSync(wavFilePath)) {
      throw new Error(`Archivo no existe: ${wavFilePath}`);
    }

    // Convertir WAV → PCM16 24kHz
    const pcm16Buffer = await this.convertWavToPCM16_24k(wavFilePath);

    if (!pcm16Buffer || pcm16Buffer.length === 0) {
      log("warn", "⚠️ [OpenAI V3] Buffer de audio vacío");
      return null;
    }

    if (pcm16Buffer.length < this.minAudioBytes) {
      log(
        "warn",
        `⚠️ [OpenAI V3] Audio demasiado corto (${pcm16Buffer.length} bytes, mín: ${this.minAudioBytes})`
      );
      return null;
    }

    log("info", `🎤 [OpenAI V3] Enviando audio: ${pcm16Buffer.length} bytes`);

    const base64Audio = pcm16Buffer.toString("base64");

    // Limpiar chunks anteriores
    this.currentAudioChunks = [];

    // Enviar audio
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: base64Audio
    });

    // Commit
    this.sendEvent({
      type: "input_audio_buffer.commit"
    });

    // Crear promesa para respuesta
    const responseKey = `response_${Date.now()}`;

    const responsePromise = new Promise((resolve, reject) => {
      this.pendingResponses.set(responseKey, { resolve, reject });

      // Timeout
      setTimeout(() => {
        if (this.pendingResponses.has(responseKey)) {
          this.pendingResponses.delete(responseKey);
          reject(new Error("Timeout esperando respuesta de OpenAI"));
        }
      }, 30000);
    });

    // Solicitar respuesta
    this.sendEvent({
      type: "response.create",
      response: {
        modalities: ["text", "audio"]
      }
    });

    const result = await responsePromise;
    return result.audioBuffer;
  }

  /**
   * 🔥 Manejo de eventos del servidor
   */
  handleServerEvent(event) {
    if (event.type !== "response.audio.delta") { // Excluir eventos de audio por ruido
      log("debug", `📩 [OpenAI V3 RAW] Evento: ${event.type}`, JSON.stringify(event).substring(0, 500));
    }

    
    switch (event.type) {
      case "session.created":
        log("info", `✅ [OpenAI V3] Sesión creada: ${event.session.id}`);
        break;

      case "conversation.item.input_audio_transcription.completed":
        const transcript = event.transcript;
        if (transcript) {
          this.lastTranscript = transcript;
          log("info", `🎯 [OpenAI V3] Transcripción completada: "${transcript}"`);
        }
        break;

      case "session.updated":
        log("debug", "⚙️ [OpenAI V3] Sesión actualizada");
        break;

      case "input_audio_buffer.committed":
        log("debug", "✅ [OpenAI V3] Audio procesado");
        break;

      case "conversation.item.created": {
        const item = event.item;
        log("debug", `📝 [OpenAI V3] Item creado: ${item.type} role=${item.role}`, item);

        if (item.type === "message" && item.role === "user") {
          // Buscar transcript en diferentes ubicaciones posibles
          const transcript = item.content?.find(c => c.type === "input_text")?.text ||
            item.content?.find(c => c.type === "input_audio")?.transcript ||
            item.transcript;

          if (transcript) {
            this.lastTranscript = transcript;
            log("info", `👤 [Usuario]: "${transcript}"`);
          } else {
            log("warn", `⚠️ [OpenAI V3] No se pudo extraer transcript del item:`, JSON.stringify(item));
          }
        }
        break;
      }

      case "response.created":
        this.activeResponseId = event.response?.id || null;
        log("debug", `📩 [OpenAI V3] Respuesta iniciada id=${this.activeResponseId}`);
        break;

      case "response.audio_transcript.delta":
        if (this.logPartialTranscripts) {
          log("debug", `🤖 [Delta]: ${event.delta}`);
        }
        break;

      case "response.audio_transcript.done":
        this.lastAssistantResponse = event.transcript || "";
        log("info", `🤖 [Asistente]: "${event.transcript}"`);
        break;

      case "response.audio.delta":
        this.handleAudioDelta(event.delta);
        break;

      case "response.audio.done":
        log("debug", "✅ [OpenAI V3] Audio completo");
        break;

      case "response.done":
        log("info", "✅ [OpenAI V3] Respuesta completada");
        this.handleResponseDone(event.response);
        this.activeResponseId = null;
        break;

      case "error":
        log("error", `❌ [OpenAI V3] Error: ${event.error?.message}`);
        break;

      default:
        log("debug", `📩 [OpenAI V3] Evento: ${event.type}`);
    }
  }

  /**
   * 📊 Acumular audio
   */
  handleAudioDelta(base64Delta) {
    if (!this.currentAudioChunks) {
      this.currentAudioChunks = [];
    }
    const chunk = Buffer.from(base64Delta, "base64");
    this.currentAudioChunks.push(chunk);
  }

  /**
   * ✅ Completar respuesta
   */
  handleResponseDone(response) {
    let audioBuffer = null;

    if (this.currentAudioChunks && this.currentAudioChunks.length > 0) {
      audioBuffer = Buffer.concat(this.currentAudioChunks);
      log("info", `🔊 [OpenAI V3] Audio total: ${audioBuffer.length} bytes`);
    }

    this.currentAudioChunks = [];

    // Resolver primera promesa pendiente
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
   * 🛑 Cancelar respuesta actual (barge-in)
   */
  cancelCurrentResponse(reason = "user_barge_in") {
    if (!this.activeResponseId) {
      log("debug", "ℹ️ [OpenAI V3] No hay respuesta activa para cancelar");
      return;
    }

    log("info", `🛑 [OpenAI V3] Cancelando respuesta (${this.activeResponseId}) por: ${reason}`);

    // Cancelar respuesta
    this.sendEvent({
      type: "response.cancel",
      response_id: this.activeResponseId
    });

    // Limpiar buffer de entrada
    this.sendEvent({
      type: "input_audio_buffer.clear"
    });

    this.activeResponseId = null;
    this.currentAudioChunks = [];
  }

  /**
   * 🔌 Desconectar
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
      log("info", "🔌 [OpenAI V3] Desconectado");
    }
  }

  /**
   * ⏸️ Pausar escucha
   */
  pauseListening() {
    this.sendEvent({
      type: "input_audio_buffer.pause"
    });
    log("info", "⏸️ [OpenAI] Escucha pausada");
  }

  /**
   * ▶️ Reanudar escucha
   */
  resumeListening() {
    this.sendEvent({
      type: "input_audio_buffer.resume"
    });
    log("info", "▶️ [OpenAI] Escucha reanudada");
  }

  /**
   * 🔄 Convertir WAV → PCM16 24kHz usando ffmpeg
   */
  async convertWavToPCM16_24k(wavFilePath) {
    const id = randomUUID();
    const pcmPath = `/tmp/${id}.pcm`;

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-y",
        "-i",
        wavFilePath,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-f",
        "s16le",
        pcmPath
      ]);

      let stderrData = "";

      ffmpeg.stderr.on("data", (data) => {
        stderrData += data.toString();
        log("debug", `[FFmpeg] ${data.toString()}`);
      });

      ffmpeg.on("error", (error) => {
        reject(new Error(`FFmpeg spawn error: ${error.message}`));
      });

      ffmpeg.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`FFmpeg error code: ${code}\n${stderrData}`));
          return;
        }

        try {
          const pcmBuffer = fs.readFileSync(pcmPath);
          fs.unlinkSync(pcmPath);
          resolve(pcmBuffer);
        } catch (err) {
          reject(err);
        }
      });
    });
  }
}