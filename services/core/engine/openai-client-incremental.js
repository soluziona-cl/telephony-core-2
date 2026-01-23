/**
 * 🎯 OPENAI REALTIME CLIENT V3 - INCREMENTAL TRANSCRIPTION WRAPPER
 * Extiende OpenAIRealtimeClientV3 para agregar soporte de transcripción incremental
 * sin modificar el cliente base
 */

import { OpenAIRealtimeClientV3 } from "./openai-client.js";
import { log } from "../../../lib/logger.js";
import { savePartialRut, getPartialRut, clearPartialRut, isValidPartialRut } from "./incremental-rut-processor.js";
import { inboundConfig as config } from "./config.js";

/**
 * Wrapper que extiende OpenAIRealtimeClientV3 con funcionalidad incremental
 */
export class OpenAIRealtimeClientV3Incremental extends OpenAIRealtimeClientV3 {
  constructor(custom = {}) {
    super(custom);
    
    // 🎯 INCREMENTAL: Callback para partials
    this.onPartialTranscript = null;
    this.partialBuffer = "";
    this.sessionId = null; // Se establecerá cuando se inicialice
    this.incrementalMode = false; // Por defecto desactivado
    this.incrementalModel = "gpt-4o-mini-transcribe";
    this.standardModel = "whisper-1";
  }

  /**
   * Establece el sessionId para guardar partials en Redis
   */
  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  /**
   * Activa el modo incremental (usa modelo que emite deltas)
   */
  enableIncremental() {
    if (this.incrementalMode) {
      log("debug", "🎯 [OpenAI V3 Incremental] Modo incremental ya estaba activado");
      return; // Ya está activado
    }
    this.incrementalMode = true;
    log("info", "🎯 [OpenAI V3 Incremental] Modo incremental ACTIVADO");
    // Si ya está conectado, actualizar sesión inmediatamente
    if (this.isConnected) {
      log("info", "🎯 [OpenAI V3 Incremental] Actualizando sesión para cambiar a modelo incremental...");
      this.updateSession();
    } else {
      log("warn", "⚠️ [OpenAI V3 Incremental] Cliente no conectado aún, modelo se configurará en connect()");
    }
  }

  /**
   * Desactiva el modo incremental (vuelve a modelo estándar)
   */
  disableIncremental() {
    if (!this.incrementalMode) return; // Ya está desactivado
    this.incrementalMode = false;
    this.partialBuffer = ""; // Limpiar buffer
    if (this.sessionId) {
      clearPartialRut(this.sessionId);
    }
    log("info", "🎯 [OpenAI V3 Incremental] Modo incremental DESACTIVADO");
    // Si ya está conectado, actualizar sesión
    if (this.isConnected) {
      this.updateSession();
    }
  }

  /**
   * Verifica si el modo incremental está activo
   */
  isIncrementalEnabled() {
    return this.incrementalMode;
  }

  /**
   * Sobrescribe updateSession para usar modelo según modo incremental
   */
  updateSession() {
    // Usar la misma lógica del padre pero con modelo según modo
    const cfg = config.openai || {};

    const transcriptionModel = this.incrementalMode 
      ? this.incrementalModel 
      : this.standardModel;

    const sessionConfig = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: this.instructions,
        voice: this.voice,
        input_audio_format: "g711_ulaw",
        output_audio_format: "pcm16",
        input_audio_transcription: {
          model: transcriptionModel
        },
        turn_detection: null,
        temperature: this.temperature,
        max_response_output_tokens: this.maxTokens
      }
    };

    this.sendEvent(sessionConfig);
    log("info", `⚙️ [OpenAI V3 Incremental] Sesión configurada: voice=${this.voice}, model=${transcriptionModel}, incremental=${this.incrementalMode}`);
  }

  /**
   * Sobrescribe handleServerEvent para agregar manejo de deltas (solo si incremental está activo)
   */
  handleServerEvent(event) {
    // 🎯 DEBUG: Log eventos del servidor cuando incremental está activo (SIN deltas de audio pesados)
    if (this.incrementalMode && event.type) {
      // ⚠️ NO loguear response.audio.delta - contiene datos base64 enormes que no son útiles
      if (event.type.includes("transcription") || (event.type.includes("delta") && !event.type.includes("audio")) || event.type.includes("item")) {
        log("info", `📡 [OpenAI V3 Incremental] Evento servidor: ${event.type}, incremental=${this.incrementalMode}, sessionId=${this.sessionId || 'NO SET'}`);
        // Solo loguear deltas de texto, no de audio
        if (event.delta && !event.type.includes("audio")) {
          log("info", `📝 [OpenAI V3 Incremental] Delta en evento: "${event.delta}"`);
        }
      }
    }

    // Llamar al handler base primero
    super.handleServerEvent(event);

    // 🎯 INCREMENTAL: Manejar eventos de transcripción parcial solo si está activo
    if (!this.incrementalMode) {
      return;
    }

    switch (event.type) {
      case "conversation.item.input_audio_transcription.delta":
        log("info", `📝 [OpenAI V3 Incremental] Delta recibido: "${event.delta || ''}"`);
        this.handleIncrementalDelta(event);
        break;

      case "conversation.item.input_audio_transcription.completed":
        log("info", `✅ [OpenAI V3 Incremental] Transcripción completada: "${event.transcript || ''}"`);
        // 🎯 FIX CRÍTICO: Evaluar identidad cuando la transcripción está completa
        // Esto permite validar el RUT solo cuando el usuario terminó de hablar
        if (this.onPartialTranscript && this.sessionId && event.transcript) {
          log("info", `🎯 [OpenAI V3 Incremental] Ejecutando evaluación final con transcript completo: "${event.transcript}"`);
          // Llamar callback con shouldEvaluate=true para ejecutar evaluación
          this.onPartialTranscript(event.transcript, this.sessionId, false).catch(err => {
            log("error", `❌ [OpenAI V3 Incremental] Error en callback onPartialTranscript (completed): ${err.message}`);
          });
        }
        // 🎯 CRÍTICO: NO resetear el buffer parcial cuando se completa una transcripción
        // El buffer parcial debe mantenerse acumulado en Redis para permitir consolidación
        // El partialBuffer en memoria se mantiene para continuar acumulando deltas
        // Solo se resetea cuando el dominio explícitamente lo borra (clearPartialRut)
        // NO resetear partialBuffer aquí - se mantiene acumulado para el siguiente delta
        break;
    }
  }

  /**
   * Maneja eventos delta de transcripción incremental
   */
  handleIncrementalDelta(event) {
    const delta = event.delta || "";
    if (!delta) {
      log("warn", `⚠️ [OpenAI V3 Incremental] Delta vacío recibido`);
      return;
    }

    // 🎯 CRÍTICO: Acumular delta en buffer en memoria (para referencia)
    // El buffer en memoria se mantiene acumulado para referencia
    // Pero en Redis usamos APPEND para acumular correctamente
    this.partialBuffer += delta;
    log("info", `📝 [OpenAI V3 Incremental] Buffer acumulado: "${this.partialBuffer}" (delta: "${delta}")`);

    // Guardar en Redis si tenemos sessionId y estamos en modo incremental
    if (!this.sessionId) {
      log("warn", `⚠️ [OpenAI V3 Incremental] sessionId no configurado, no se puede guardar partial`);
      return;
    }

    if (!this.onPartialTranscript) {
      log("warn", `⚠️ [OpenAI V3 Incremental] Callback onPartialTranscript no registrado`);
      return;
    }

    log("info", `🎯 [OpenAI V3 Incremental] Ejecutando callback con sessionId=${this.sessionId}, delta="${delta}"`);
    // Ejecutar callback con el DELTA (no el buffer completo) para usar APPEND
    // El callback usará APPEND en Redis para acumular correctamente
    this.onPartialTranscript(delta, this.sessionId, true).catch(err => {
      log("error", `❌ [OpenAI V3 Incremental] Error en callback onPartialTranscript: ${err.message}`);
    });
  }

  /**
   * Limpia el buffer parcial
   */
  clearPartialBuffer() {
    this.partialBuffer = "";
    if (this.sessionId) {
      clearPartialRut(this.sessionId);
    }
  }

  /**
   * Obtiene el RUT parcial actual desde Redis
   */
  async getPartialRut() {
    if (!this.sessionId) return '';
    return await getPartialRut(this.sessionId);
  }

  /**
   * Verifica si hay un RUT parcial válido
   */
  async hasValidPartialRut() {
    if (!this.sessionId) return false;
    const partialRut = await getPartialRut(this.sessionId);
    return isValidPartialRut(partialRut);
  }
}

/**
 * Factory function para crear cliente con soporte incremental
 * @param {object} custom - Configuración personalizada
 * @param {string} sessionId - ID de sesión para Redis
 * @returns {OpenAIRealtimeClientV3Incremental}
 */
export function createIncrementalClient(custom = {}, sessionId = null) {
  const client = new OpenAIRealtimeClientV3Incremental(custom);
  if (sessionId) {
    client.setSessionId(sessionId);
    log("info", `🎯 [OpenAI V3 Incremental] Cliente creado con sessionId=${sessionId}`);
  } else {
    log("warn", `⚠️ [OpenAI V3 Incremental] Cliente creado SIN sessionId`);
  }
  return client;
}
