/**
 * 🎬 AUDIO EXTRACTOR - Extracción de segmentos del WAV continuo usando ffmpeg
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { log } from '../../../../lib/logger.js';
import os from 'os';

const execAsync = promisify(exec);

// Directorio temporal para segmentos extraídos
const TEMP_DIR = process.env.SEGMENT_TEMP_DIR || path.join(os.tmpdir(), 'telephony-segments');

// Asegurar que el directorio temporal existe
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Extraer segmento de audio del WAV continuo
 * @param {string} inputWavPath - Ruta del WAV continuo
 * @param {number} startMs - Inicio del segmento en milisegundos
 * @param {number} endMs - Fin del segmento en milisegundos
 * @param {string} segId - ID del segmento (para nombre de archivo)
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function extractSegment(inputWavPath, startMs, endMs, segId) {
    // Validar que el archivo de entrada existe
    if (!fs.existsSync(inputWavPath)) {
        log('error', `❌ [EXTRACTOR] Archivo de entrada no existe: ${inputWavPath}`);
        return { ok: false, error: 'input_file_not_found' };
    }

    // Validar parámetros
    if (endMs <= startMs) {
        log('error', `❌ [EXTRACTOR] Parámetros inválidos: endMs (${endMs}) <= startMs (${startMs})`);
        return { ok: false, error: 'invalid_parameters' };
    }

    const durationMs = endMs - startMs;
    const startSeconds = startMs / 1000;
    const durationSeconds = durationMs / 1000;

    // Ruta de salida temporal
    const outputPath = path.join(TEMP_DIR, `${segId}.wav`);

    try {
        // Comando ffmpeg para extraer segmento
        // -ss: tiempo de inicio
        // -t: duración
        // -acodec copy: copiar audio sin re-encodear (más rápido)
        // Si falla copy, usar re-encode con pcm_s16le
        const ffmpegCmd = `ffmpeg -y -ss ${startSeconds.toFixed(3)} -t ${durationSeconds.toFixed(3)} -i "${inputWavPath}" -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`;

        log('info', `🎬 [EXTRACTOR] Extrayendo segmento: ${segId}`, {
            input: inputWavPath,
            startMs,
            endMs,
            durationMs,
            output: outputPath
        });

        const { stdout, stderr } = await execAsync(ffmpegCmd, {
            timeout: 30000, // 30s timeout
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        });

        // Verificar que el archivo se creó
        if (!fs.existsSync(outputPath)) {
            log('error', `❌ [EXTRACTOR] Archivo de salida no se creó: ${outputPath}`);
            return { ok: false, error: 'output_file_not_created' };
        }

        const stats = fs.statSync(outputPath);
        if (stats.size < 1000) { // Menos de 1KB probablemente es un error
            log('warn', `⚠️ [EXTRACTOR] Archivo de salida muy pequeño (${stats.size} bytes) - posible error`);
            fs.unlinkSync(outputPath);
            return { ok: false, error: 'output_file_too_small' };
        }

        log('info', `✅ [EXTRACTOR] Segmento extraído: ${segId}`, {
            outputPath,
            size: stats.size,
            durationMs
        });

        return { ok: true, path: outputPath };

    } catch (error) {
        log('error', `❌ [EXTRACTOR] Error extrayendo segmento ${segId}: ${error.message}`, {
            error: error.message,
            stderr: error.stderr,
            stdout: error.stdout
        });

        // Limpiar archivo parcial si existe
        if (fs.existsSync(outputPath)) {
            try {
                fs.unlinkSync(outputPath);
            } catch (unlinkErr) {
                log('warn', `⚠️ [EXTRACTOR] Error limpiando archivo parcial: ${unlinkErr.message}`);
            }
        }

        return { ok: false, error: error.message };
    }
}

/**
 * Limpiar archivo temporal de segmento
 * @param {string} segmentPath - Ruta del archivo a limpiar
 */
export async function cleanupSegment(segmentPath) {
    try {
        if (fs.existsSync(segmentPath)) {
            fs.unlinkSync(segmentPath);
            log('debug', `🧹 [EXTRACTOR] Segmento limpiado: ${segmentPath}`);
        }
    } catch (error) {
        log('warn', `⚠️ [EXTRACTOR] Error limpiando segmento ${segmentPath}: ${error.message}`);
    }
}

/**
 * Limpiar todos los segmentos temporales de una llamada
 * @param {string} callId - ID de la llamada
 */
export async function cleanupCallSegments(callId) {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const callFiles = files.filter(f => f.startsWith(`seg_`) && f.includes(callId));

        for (const file of callFiles) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                fs.unlinkSync(filePath);
            } catch (err) {
                log('warn', `⚠️ [EXTRACTOR] Error limpiando ${filePath}: ${err.message}`);
            }
        }

        if (callFiles.length > 0) {
            log('info', `🧹 [EXTRACTOR] ${callFiles.length} segmentos limpiados para ${callId}`);
        }
    } catch (error) {
        log('warn', `⚠️ [EXTRACTOR] Error limpiando segmentos de ${callId}: ${error.message}`);
    }
}
