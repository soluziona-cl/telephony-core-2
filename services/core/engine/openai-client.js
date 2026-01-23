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
import { spawn, exec } from "child_process";
import { promisify } from "util";
import { log } from "../../../lib/logger.js";
const execAsync = promisify(exec);
import { inboundConfig as config } from "./config.js";
const logCfg = config.logging || {};

export class OpenAIRealtimeClientV3 {
  static ttsCache = new Map();

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

    this.logPartialTranscripts = logCfg.partialTranscripts;

    this.ws = null;
    this.isConnected = false;

    this.pendingResponses = new Map();
    this.currentAudioChunks = [];

    // Para barge-in
    this.activeResponseId = null;

    // Para capturar transcripts
    this.lastTranscript = "";
    this.lastAssistantResponse = "";

    this.isSystemPrompt = false;
    this.isPlaybackActive = false;
    
    // 🎯 MEJORA CRÍTICA: Tracking de estabilidad del stream de audio
    this.audioDeltaTracking = {
      lastDeltaAt: 0,
      deltaGapTimer: null,
      streamStabilityThreshold: 300, // ms sin deltas = stream pausado/estable
      isStreamActive: false,
      onStreamStable: null // Callback cuando stream se estabiliza
    };
  }

  /**
   * 🔌 Conectar al WebSocket
   */
  async connect() {
    if (!this.apiKey) {
      log("error", "❌ [OpenAI V3] Error: OPENAI_API_KEY no configurada.");
      return;
    }

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
        input_audio_format: "g711_ulaw",
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
   */
  async sendTextAndWait(text, role = "user") {
    log("info", `💬 [OpenAI V3] Enviando texto (${role}): "${text}"`);
    this.currentAudioChunks = [];
    const contentType = role === "assistant" ? "text" : "input_text";
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: role,
        content: [{ type: contentType, text: text }]
      }
    });

    const responseKey = `text_response_${Date.now()}`;
    const responsePromise = new Promise((resolve, reject) => {
      this.pendingResponses.set(responseKey, { resolve, reject });
      setTimeout(() => {
        if (this.pendingResponses.has(responseKey)) {
          this.pendingResponses.delete(responseKey);
          reject(new Error("Timeout esperando respuesta de OpenAI"));
        }
      }, 30000);
    });

    this.sendEvent({
      type: "response.create",
      response: { modalities: ["text", "audio"] }
    });

    const result = await responsePromise;
    return result.audioBuffer;
  }

  /**
   * 🎤 Enviar audio y esperar respuesta
   */
  async sendAudioAndWait(wavFilePath) {
    if (!fs.existsSync(wavFilePath)) {
      throw new Error(`Archivo no existe: ${wavFilePath}`);
    }

    // 🔄 Asegurar conexión antes de enviar audio
    await this.ensureConnected();

    const pcm16Buffer = await this.convertWavToPCM16_24k(wavFilePath);

    if (!pcm16Buffer || pcm16Buffer.length === 0) {
      log("warn", "⚠️ [OpenAI V3] Buffer de audio vacío");
      return null;
    }

    // 🔥 V3 FIX: Nunca enviar < minAudioMs (180ms/120ms según config)
    if (pcm16Buffer.length < this.minAudioBytes) {
      log("warn", `⚠️ [OpenAI V3] Audio ignorado por ser demasiado corto (${pcm16Buffer.length} bytes < ${this.minAudioBytes})`);
      return null;
    }

    const base64Audio = pcm16Buffer.toString("base64");
    this.currentAudioChunks = [];

    // 🔥 V3 FIX: No enviar audio si hay una respuesta activa (barge-in protection)
    if (this.activeResponseId || this.isPlaybackActive) {
      log("warn", "⚠️ [OpenAI V3] Bloqueando envío de audio: hay una respuesta activa o reproducción.");
      return null;
    }

    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: base64Audio
    });

    this.sendEvent({
      type: "input_audio_buffer.commit"
    });

    const responseKey = `response_${Date.now()}`;
    const responsePromise = new Promise((resolve, reject) => {
      this.pendingResponses.set(responseKey, { resolve, reject });
      setTimeout(() => {
        if (this.pendingResponses.has(responseKey)) {
          this.pendingResponses.delete(responseKey);
          reject(new Error("Timeout esperando respuesta de OpenAI"));
        }
      }, 30000);
    });

    this.sendEvent({
      type: "response.create",
      response: { modalities: ["text", "audio"] }
    });

    const result = await responsePromise;
    return result.audioBuffer;
  }

  /**
   * 🎤 Transcribir audio SIN generar respuesta (Strict Mode)
   */
  async transcribeAudioOnly(wavFilePath) {
    if (!fs.existsSync(wavFilePath)) {
      throw new Error(`Archivo no existe: ${wavFilePath}`);
    }

    // 🔄 Asegurar conexión antes de transcribir
    await this.ensureConnected();

    const pcm16Buffer = await this.convertWavToPCM16_24k(wavFilePath);

    if (!pcm16Buffer || pcm16Buffer.length === 0) {
      log("warn", "⚠️ [OpenAI V3] Buffer de audio vacío");
      return null;
    }

    if (pcm16Buffer.length < this.minAudioBytes) {
      log("warn", `⚠️ [OpenAI V3] Audio ignorado por ser demasiado corto`);
      return null;
    }

    const base64Audio = pcm16Buffer.toString("base64");
    this.currentAudioChunks = [];
    this.lastTranscript = ""; // Reset transcript

    // Enviar audio
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: base64Audio
    });

    this.sendEvent({
      type: "input_audio_buffer.commit"
    });

    // Esperar a que llegue el evento de transcripción
    // No enviamos response.create, así que el servidor solo procesará el input
    // Y nos devolverá conversation.item.input_audio_transcription.completed

    // NOTA: OpenAI Realtime *a veces* puede no devolver transcript si VAD no detecta nada o piensa que es ruido.
    // Implementamos un polling sobre this.lastTranscript

    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (this.lastTranscript) return this.lastTranscript;
      await new Promise(r => setTimeout(r, 100));
    }

    return this.lastTranscript || "";
  }

  /**
   * 🗣️ Generar TTS explícito usando la API estándar (no realtime)
   * Esto asegura que el texto dicho sea EXACTAMENTE el que queremos.
   */
  /**
   * 🗣️ Generar TTS explícito usando la API estándar (no realtime)
   * Esto asegura que el texto dicho sea EXACTAMENTE el que queremos.
   * INCLUYE CACHÉ EN MEMORIA (STATIC) para reducir latencia en frases repetitivas.
   */
  async synthesizeSpeech(text) {
    // 1. Revisar caché global
    const cacheKey = `${text}_${this.voice}`;
    if (OpenAIRealtimeClientV3.ttsCache.has(cacheKey)) {
      log("info", `⚡ [TTS Cache] HIT GLOBAL para: "${text.substring(0, 30)}..."`);
      return OpenAIRealtimeClientV3.ttsCache.get(cacheKey);
    }

    log("info", `🗣️ [TTS Explicit] Sintetizando: "${text}"`);
    const mp3Path = `/tmp/tts_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
    const pcmPath = `/tmp/tts_${Date.now()}_${Math.random().toString(36).substring(7)}.pcm`;
    const jsonPath = `/tmp/tts_payload_${Date.now()}_${Math.random().toString(36).substring(7)}.json`;

    try {
      // 2. Preparar payload seguro (evitar shell injection)
      // Validar voz. gpt-4o-mini-tts soporta 13 voces.
      const validVoices = [
        'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
        'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
      ];
      let ttsVoice = this.voice.toLowerCase();

      if (!validVoices.includes(ttsVoice)) {
        log("warn", `⚠️ [TTS Explicit] Voz '${ttsVoice}' no reconocida. Usando fallback 'shimmer'.`);
        ttsVoice = 'shimmer';
      }

      const payload = JSON.stringify({
        model: "gpt-4o-mini-tts",
        input: text,
        voice: ttsVoice,
        instructions: "Speak seamlessly and naturally in Chilean Spanish."
      });
      fs.writeFileSync(jsonPath, payload);

      // 3. Ejecutar CURL usando el archivo de payload
      // -s: Silent mode
      // -f: Fail silently on server errors (no output)
      // -w: Write out HTTP code
      const cmd = `curl https://api.openai.com/v1/audio/speech \
          -H "Authorization: Bearer ${this.apiKey}" \
          -H "Content-Type: application/json" \
          -d @${jsonPath} \
          --output "${mp3Path}" \
          -w "%{http_code}" -s`;

      const { stdout } = await execAsync(cmd);
      const httpCode = parseInt(stdout.trim());

      if (httpCode !== 200) {
        throw new Error(`OpenAI TTS API returned HTTP ${httpCode}`);
      }

      // 4. Validar que el archivo MP3 tenga contenido
      const stats = fs.statSync(mp3Path);
      if (stats.size < 100) {
        throw new Error("TTS MP3 file too small (possible error content)");
      }

      // 5. Convertir MP3 a PCM (s16le 24k)
      const convertCmd = `ffmpeg -y -i "${mp3Path}" -f s16le -ac 1 -ar 24000 "${pcmPath}"`;
      await execAsync(convertCmd);

      const buffer = fs.readFileSync(pcmPath);

      // 6. Guardar en caché GLOBAL
      OpenAIRealtimeClientV3.ttsCache.set(cacheKey, buffer);

      // Cleanup temp files
      try {
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
        if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
        if (fs.existsSync(pcmPath)) fs.unlinkSync(pcmPath);
      } catch (e) { /* ignore cleanup errors */ }

      return buffer;

    } catch (err) {
      log("error", `❌ [TTS Explicit] Error: ${err.message}`);
      // Cleanup on error
      try {
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
        if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
        if (fs.existsSync(pcmPath)) fs.unlinkSync(pcmPath);
      } catch (e) { }

      return null;
    }
  }

  /**
   * 🔥 Manejo de eventos del servidor
   */
  handleServerEvent(event) {
    if (logCfg.rawEvents && event.type !== "response.audio.delta") {
      log("debug", `📩 [OpenAI RAW] ${event.type}`, JSON.stringify(event).substring(0, 500));
    }

    switch (event.type) {
      case "session.created":
        log("info", `✅ [OpenAI V3] Sesión creada: ${event.session.id}`);
        break;

      case "conversation.item.input_audio_transcription.completed":
        this.lastTranscript = event.transcript || "";
        log("info", `🎯 [OpenAI V3] Transcripción completada: "${this.lastTranscript}"`);
        break;

      case "conversation.item.created": {
        const item = event.item;
        if (item.type === "message" && item.role === "user") {
          if (this.isSystemPrompt) {
            this.isSystemPrompt = false;
            return;
          }
          const transcript = item.content?.find(c => c.type === "input_text")?.text ||
            item.content?.find(c => c.type === "input_audio")?.transcript ||
            item.transcript;

          if (transcript) this.lastTranscript = transcript;
        }
        break;
      }

      case "response.created":
        this.activeResponseId = event.response?.id || null;
        // 🎯 MEJORA: Reset tracking cuando inicia nueva respuesta
        this.audioDeltaTracking.lastDeltaAt = Date.now();
        this.audioDeltaTracking.isStreamActive = true;
        if (this.audioDeltaTracking.deltaGapTimer) {
          clearTimeout(this.audioDeltaTracking.deltaGapTimer);
        }
        break;

      case "response.audio_transcript.done":
        this.lastAssistantResponse = event.transcript || "";
        log("info", `🤖 [Asistente]: "${event.transcript}"`);
        break;

      case "response.audio.delta":
        this.handleAudioDelta(event.delta);
        // 🎯 MEJORA CRÍTICA: Detectar estabilidad del stream
        this.handleStreamStability();
        break;

      case "response.done":
        log("info", "✅ [OpenAI V3] Respuesta completada");
        this.handleResponseDone(event.response);
        this.activeResponseId = null;
        // 🎯 MEJORA: Marcar stream como finalizado
        this.audioDeltaTracking.isStreamActive = false;
        if (this.audioDeltaTracking.deltaGapTimer) {
          clearTimeout(this.audioDeltaTracking.deltaGapTimer);
        }
        // Emitir evento de estabilidad final si hay callback
        if (this.audioDeltaTracking.onStreamStable) {
          this.audioDeltaTracking.onStreamStable('stream-complete');
        }
        break;

      case "error":
        log("error", `❌ [OpenAI V3] Error: ${event.error?.message}`);
        break;

    }
  }

  handleAudioDelta(base64Delta) {
    if (!this.currentAudioChunks) this.currentAudioChunks = [];
    this.currentAudioChunks.push(Buffer.from(base64Delta, "base64"));
  }

  /**
   * 🎯 MEJORA CRÍTICA: Detectar estabilidad del stream de audio
   * Detecta cuando hay una pausa en el stream (gap entre deltas)
   * Esto permite invocar webhook sin esperar el fin completo del stream
   */
  handleStreamStability() {
    const now = Date.now();
    const lastDeltaAt = this.audioDeltaTracking.lastDeltaAt;
    const threshold = this.audioDeltaTracking.streamStabilityThreshold;
    
    // Actualizar timestamp del último delta
    this.audioDeltaTracking.lastDeltaAt = now;
    
    // Reset timer anterior
    if (this.audioDeltaTracking.deltaGapTimer) {
      clearTimeout(this.audioDeltaTracking.deltaGapTimer);
    }
    
    // Si hay un gap significativo desde el último delta, el stream está pausado
    if (lastDeltaAt > 0 && (now - lastDeltaAt) > threshold) {
      log("debug", `⏸️ [OpenAI V3] Stream pausado detectado (gap: ${now - lastDeltaAt}ms)`);
      // Emitir evento de estabilidad
      if (this.audioDeltaTracking.onStreamStable) {
        this.audioDeltaTracking.onStreamStable('stream-paused');
      }
    }
    
    // 🎯 TIMER: Si no llegan más deltas por threshold ms, considerar stream estable
    this.audioDeltaTracking.deltaGapTimer = setTimeout(() => {
      if (this.audioDeltaTracking.isStreamActive) {
        const gap = Date.now() - this.audioDeltaTracking.lastDeltaAt;
        log("info", `⏸️ [OpenAI V3] Stream estabilizado (${gap}ms sin deltas) → Listo para webhook`);
        
        // Emitir evento de estabilidad
        if (this.audioDeltaTracking.onStreamStable) {
          this.audioDeltaTracking.onStreamStable('stream-stable');
        }
      }
    }, threshold);
  }

  /**
   * 🎯 MEJORA: Registrar callback para eventos de estabilidad del stream
   */
  onStreamStable(callback) {
    this.audioDeltaTracking.onStreamStable = callback;
  }

  handleResponseDone(response) {
    let audioBuffer = null;
    if (this.currentAudioChunks && this.currentAudioChunks.length > 0) {
      audioBuffer = Buffer.concat(this.currentAudioChunks);
    }
    this.currentAudioChunks = [];

    // Resolver por mutex (la primera promesa pendiente que coincida)
    for (const [key, pending] of this.pendingResponses.entries()) {
      pending.resolve({ audioBuffer, response });
      this.pendingResponses.delete(key);
      break;
    }
  }

  cancelCurrentResponse(reason = "user_barge_in") {
    if (!this.isPlaybackActive || !this.activeResponseId) return;
    this.isPlaybackActive = false;
    this.sendEvent({ type: "response.cancel", response_id: this.activeResponseId });
    this.sendEvent({ type: "input_audio_buffer.clear" });
    this.activeResponseId = null;
    this.currentAudioChunks = [];
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }
  }

  /**
   * 🔄 Asegurar conexión activa (auto-reconnect)
   */
  async ensureConnected() {
    if (!this.isConnected && this.apiKey) {
      log("warn", "⚠️ [OpenAI V3] Reconectando...");
      try {
        await this.connect();
        log("info", "✅ [OpenAI V3] Reconexión exitosa");
      } catch (err) {
        log("error", `❌ [OpenAI V3] Fallo en reconexión: ${err.message}`);
        throw err;
      }
    }
  }

  /**
   * 📝 Transcribir audio usando Whisper (v1/audio/transcriptions)
   */
  async transcribeAudioWithWhisper(wavFilePath) {
    if (!fs.existsSync(wavFilePath)) return "";
    try {
      log("info", `📝 [Whisper] Transcribiendo fallback para: ${wavFilePath}`);
      const { stdout } = await execAsync(
        `curl https://api.openai.com/v1/audio/transcriptions \
          -H "Authorization: Bearer ${this.apiKey}" \
          -H "Content-Type: multipart/form-data" \
          -F file="@${wavFilePath}" \
          -F model="whisper-1" \
          -F language="es"`
      );
      const result = JSON.parse(stdout);
      return result.text || "";
    } catch (err) {
      log("error", `❌ [Whisper] Error en transcripción fallback: ${err.message}`);
      return "";
    }
  }

  async convertWavToPCM16_24k(wavFilePath) {
    const pcmPath = `/tmp/${Math.random().toString(36).substring(7)}.pcm`;
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", ["-y", "-i", wavFilePath, "-ar", "24000", "-ac", "1", "-f", "s16le", pcmPath]);
      ffmpeg.on("close", (code) => {
        if (code !== 0) return reject(new Error(`FFmpeg code: ${code}`));
        try {
          const buffer = fs.readFileSync(pcmPath);
          fs.unlinkSync(pcmPath);
          resolve(buffer);
        } catch (e) { reject(e); }
      });
    });
  }

  async sendSystemText(text) {
    // Usamos role 'assistant' para que OpenAI genere el audio como si él lo dijera
    return await this.sendTextAndWait(text, "assistant");
  }

  // =========================================================
  // 🌊 STREAMING SUPPORT (ExternalMedia)
  // =========================================================

  streamAudio(buffer) {
    if (!this.isConnected) return;

    // ✅ ARQUITECTURA DESACOPLADA: El canal de entrada siempre escucha
    // El audio se captura siempre, independiente del estado de playback
    // La decisión de interrumpir se toma después, gobernada por interruptPolicy del dominio
    // 
    // NOTA: isPlaybackActive se mantiene para tracking, pero NO bloquea la captura de audio
    // La interrupción se evalúa en el engine según interruptPolicy del dominio

    // Send raw audio delta directly (OpenAI handles buffering)
    // Assuming buffer is correct format (configured in session)
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: buffer.toString('base64')
    });
  }

  commit() {
    if (!this.isConnected) {
      log("warn", "⚠️ [OpenAI V3] commit() llamado pero cliente no conectado");
      return;
    }
    this.lastTranscript = ""; // Reset for new turn
    this.sendEvent({ type: 'input_audio_buffer.commit' });
    log("debug", "🔄 [OpenAI V3] Commit enviado al buffer de audio");
  }

  async waitForTranscript(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.lastTranscript) return this.lastTranscript;
      await new Promise(r => setTimeout(r, 100));
    }
    return "";
  }
}