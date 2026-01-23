/**
 * 🎙️ STT WORKER - Procesador de segmentos con STT batch
 * 
 * Conecta extractor + OpenAI STT + parsers determinísticos
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { extractWavSegmentMs } from "../recording/extractor.js";
import { log } from "../../../lib/logger.js";
import { createReadStream } from "fs";

// Usar FormData global (Node.js 18+) o importar form-data si es necesario
// En Node.js 18+, FormData está disponible globalmente
const FormData = globalThis.FormData;

/**
 * Crear worker de STT
 * @param {Object} params
 * @param {Function} params.logger - Logger
 * @param {Function} params.getRecordingPathByCallId - Función que obtiene ruta de grabación
 * @param {Function} params.onTranscript - Callback cuando se recibe transcript
 * @returns {Function} - Función worker
 */
export function createSttWorker({
    logger,
    getRecordingPathByCallId,
    onTranscript
}) {
    const logFn = logger || log;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || "whisper-1";
    const STT_BATCH_URL = "https://api.openai.com/v1/audio/transcriptions";

    /**
     * Transcribir audio con OpenAI Whisper
     * @param {string} wavPath - Ruta del archivo WAV
     * @param {string} purpose - Propósito/fase (ej: LISTEN_RUT)
     * @returns {Promise<string>} - Texto transcrito
     */
    async function openaiTranscribe(wavPath, purpose) {
        if (!OPENAI_API_KEY) {
            throw new Error("OPENAI_API_KEY no configurada");
        }

        // Crear FormData (Node.js 18+ tiene FormData global)
        const form = new FormData();
        const fileStream = createReadStream(wavPath);
        form.append("file", fileStream, {
            filename: path.basename(wavPath),
            contentType: "audio/wav"
        });
        form.append("model", OPENAI_STT_MODEL);
        form.append("language", "es"); // Español para Quintero

        // Prompt opcional según fase
        if (purpose === "LISTEN_RUT") {
            form.append("prompt", "El usuario está diciendo un RUT chileno. Puede incluir números, guiones, puntos, y la palabra 'mil'. Ejemplo: 'dieciséis mil doscientos cuarenta y siete cero sesenta y siete'.");
        }

        // En Node.js 18+, FormData global no tiene getHeaders(), usar directamente
        const response = await fetch(STT_BATCH_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`
                // No incluir Content-Type, fetch lo maneja automáticamente con FormData
            },
            body: form
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenAI STT error: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        return result.text || "";
    }

    /**
     * Worker principal
     * @param {Object} segment - Segmento a procesar
     */
    return async function sttWorker(segment) {
        const inputPath = await getRecordingPathByCallId(segment.callId);
        if (!inputPath) {
            throw new Error(`Recording path not found for callId=${segment.callId}`);
        }

        const tmpOut = path.join(os.tmpdir(), `${segment.callId}_${segment.segId}.wav`);

        logFn("info", `[STT] EXTRACT segId=${segment.segId} start=${segment.startMs} end=${segment.endMs} input=${inputPath}`);
        
        try {
            // 1. Extraer segmento del WAV continuo
            await extractWavSegmentMs({
                inputPath,
                startMs: segment.startMs,
                endMs: segment.endMs,
                outputPath: tmpOut,
                sampleRate: 8000
            });

            // 2. Transcribir con OpenAI
            const text = await openaiTranscribe(tmpOut, segment.phase);

            logFn("info", `[STT] DONE segId=${segment.segId} phase=${segment.phase} text="${String(text).slice(0, 120)}"`);

            // 3. Limpiar archivo temporal
            try {
                fs.unlinkSync(tmpOut);
            } catch (unlinkErr) {
                logFn("warn", `[STT] Error limpiando temporal: ${unlinkErr.message}`);
            }

            // 4. Notificar transcript al handler
            await onTranscript({ segment, text });

        } catch (err) {
            logFn("error", `[STT] Error procesando segmento ${segment.segId}: ${err.message}`, {
                error: err.message,
                stack: err.stack,
                segment
            });
            
            // Limpiar archivo temporal en caso de error
            try {
                if (fs.existsSync(tmpOut)) {
                    fs.unlinkSync(tmpOut);
                }
            } catch (unlinkErr) {
                // Ignorar
            }
            
            throw err;
        }
    };
}
