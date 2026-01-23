/**
 * 🎬 EXTRACTOR - Extracción de segmentos WAV por milisegundos usando ffmpeg
 * 
 * Extrae un rango específico [startMs, endMs] del WAV continuo.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { log } from "../../../lib/logger.js";

/**
 * Extraer segmento WAV por rango de milisegundos
 * @param {Object} params
 * @param {string} params.inputPath - Ruta del WAV continuo
 * @param {number} params.startMs - Inicio en milisegundos
 * @param {number} params.endMs - Fin en milisegundos
 * @param {string} params.outputPath - Ruta de salida del segmento
 * @param {number} params.sampleRate - Sample rate (default: 8000)
 * @returns {Promise<string>} - Ruta del archivo extraído
 */
export async function extractWavSegmentMs({
    inputPath,
    startMs,
    endMs,
    outputPath,
    sampleRate = 8000
}) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        throw new Error(`Invalid segment range: ${startMs}..${endMs}`);
    }

    // Crear directorio si no existe
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Validar que el archivo de entrada existe
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Input file not found: ${inputPath}`);
    }

    const ss = (startMs / 1000).toFixed(3);
    const dur = ((endMs - startMs) / 1000).toFixed(3);

    // Nota: -ss después de -i es más exacto (más lento). Para RUT, precisión > velocidad.
    const args = [
        "-hide_banner",
        "-loglevel", "error",
        "-i", inputPath,
        "-ss", ss,
        "-t", dur,
        "-ac", "1",
        "-ar", String(sampleRate),
        "-c:a", "pcm_s16le",
        outputPath
    ];

    log("info", `🎬 [EXTRACTOR] Extrayendo segmento`, {
        input: inputPath,
        startMs,
        endMs,
        duration: endMs - startMs,
        output: outputPath
    });

    await new Promise((resolve, reject) => {
        const p = spawn("ffmpeg", args);
        let err = "";
        p.stderr.on("data", d => (err += d.toString()));
        p.on("close", code => {
            if (code === 0) {
                // Verificar que el archivo se creó
                if (fs.existsSync(outputPath)) {
                    const stats = fs.statSync(outputPath);
                    if (stats.size < 1000) {
                        reject(new Error(`Output file too small (${stats.size} bytes) - extraction may have failed`));
                    } else {
                        log("info", `✅ [EXTRACTOR] Segmento extraído: ${outputPath} (${stats.size} bytes)`);
                        resolve();
                    }
                } else {
                    reject(new Error("Output file was not created"));
                }
            } else {
                reject(new Error(`ffmpeg failed (${code}): ${err.slice(-500)}`));
            }
        });
    });

    return outputPath;
}
