/**
 * 📥 STT BATCH QUEUE - Procesamiento de segmentos con STT batch
 */

import { log } from '../../../../lib/logger.js';
import redis from '../../../../lib/redis.js';
import { extractSegment, cleanupSegment } from './audio-extractor.js';
import { createReadStream } from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

// Nota: redis.on('message') requiere que redis sea un cliente pub/sub
// Si redis no soporta pub/sub directamente, usar un patrón alternativo

// Configuración
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || 'whisper-1';
const STT_BATCH_URL = 'https://api.openai.com/v1/audio/transcriptions';

// Estado del procesador
let processorRunning = false;
let processorInterval = null;

/**
 * Procesar un segmento con STT batch
 * @param {Object} queueItem - Item de la cola con información del segmento
 * @returns {Promise<{ok: boolean, transcript?: string, error?: string}>}
 */
async function processSegment(queueItem) {
    const { callId, linkedId, segment, recordingName, recordingPath } = queueItem;

    log('info', `🎙️ [STT BATCH] Procesando segmento: ${segment.segId}`, {
        callId,
        phase: segment.phase,
        startMs: segment.startMs,
        endMs: segment.endMs
    });

    // 1. Extraer segmento del WAV continuo
    const extractResult = await extractSegment(
        recordingPath,
        segment.startMs,
        segment.endMs,
        segment.segId
    );

    if (!extractResult.ok) {
        log('error', `❌ [STT BATCH] Error extrayendo segmento ${segment.segId}: ${extractResult.error}`);
        
        // Actualizar estado del segmento en Redis
        await _updateSegmentStatus(callId, segment.segId, 'failed', { error: extractResult.error });
        
        return { ok: false, error: extractResult.error };
    }

    const segmentPath = extractResult.path;

    try {
        // 2. Enviar a OpenAI STT
        const transcript = await _sendToOpenAI(segmentPath, segment.phase);

        // 3. Actualizar estado del segmento
        await _updateSegmentStatus(callId, segment.segId, 'completed', { transcript });

        // 4. Publicar transcript al dominio
        await _publishTranscript(callId, linkedId, segment, transcript);

        log('info', `✅ [STT BATCH] Segmento procesado: ${segment.segId}`, {
            transcriptLength: transcript.length,
            phase: segment.phase
        });

        return { ok: true, transcript };

    } catch (error) {
        log('error', `❌ [STT BATCH] Error procesando segmento ${segment.segId}: ${error.message}`);
        
        await _updateSegmentStatus(callId, segment.segId, 'failed', { error: error.message });
        
        return { ok: false, error: error.message };

    } finally {
        // 5. Limpiar archivo temporal
        await cleanupSegment(segmentPath);
    }
}

/**
 * Enviar audio a OpenAI STT
 */
async function _sendToOpenAI(audioPath, phase) {
    if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY no configurada');
    }

    const form = new FormData();
    form.append('file', createReadStream(audioPath));
    form.append('model', OPENAI_STT_MODEL);
    form.append('language', 'es'); // Español para Quintero

    // Prompt opcional según fase
    if (phase === 'LISTEN_RUT') {
        form.append('prompt', 'El usuario está diciendo un RUT chileno. Puede incluir números, guiones, puntos, y la palabra "mil". Ejemplo: "dieciséis mil doscientos cuarenta y siete cero sesenta y siete".');
    }

    const response = await fetch(STT_BATCH_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            ...form.getHeaders()
        },
        body: form
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI STT error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    return result.text || '';
}

/**
 * Actualizar estado del segmento en Redis
 */
async function _updateSegmentStatus(callId, segId, status, data = {}) {
    const segmentsKey = `call:${callId}:segments`;
    const segments = await redis.lRange(segmentsKey, 0, -1);

    for (let i = 0; i < segments.length; i++) {
        const segment = JSON.parse(segments[i]);
        if (segment.segId === segId) {
            segment.stt = { status, ...data, updatedAt: new Date().toISOString() };
            await redis.lSet(segmentsKey, i, JSON.stringify(segment));
            break;
        }
    }
}

/**
 * Publicar transcript al dominio para procesamiento
 * Nota: El transcript se guarda en Redis para que el engine lo consuma
 * El engine puede consultar estos resultados cuando necesite procesar un segmento
 */
async function _publishTranscript(callId, linkedId, segment, transcript) {
    const event = {
        type: 'STT_BATCH_RESULT',
        callId,
        linkedId,
        segment: {
            segId: segment.segId,
            phase: segment.phase,
            startMs: segment.startMs,
            endMs: segment.endMs
        },
        transcript,
        timestamp: new Date().toISOString()
    };

    // Guardar resultado en Redis (key por segmento)
    const resultKey = `stt:batch:result:${callId}:${segment.segId}`;
    await redis.set(resultKey, JSON.stringify(event), { EX: 3600 });
    
    // Publicar evento para notificar al engine (si está escuchando)
    await redis.publish('engine:stt:batch:result', JSON.stringify(event));
    
    log('info', `📤 [STT BATCH] Transcript guardado y publicado para ${segment.segId}`, {
        phase: segment.phase,
        transcriptLength: transcript.length,
        resultKey
    });
}

/**
 * Procesador principal de la cola
 */
async function processQueue() {
    if (processorRunning) {
        return; // Ya está procesando
    }

    processorRunning = true;

    try {
        const queueKey = 'stt:batch:queue';
        
        // Obtener siguiente item de la cola (FIFO)
        const itemJson = await redis.rPop(queueKey);
        
        if (!itemJson) {
            return; // Cola vacía
        }

        const queueItem = JSON.parse(itemJson);
        await processSegment(queueItem);

    } catch (error) {
        log('error', `❌ [STT BATCH QUEUE] Error procesando cola: ${error.message}`);
    } finally {
        processorRunning = false;
    }
}

/**
 * Iniciar procesador de cola
 */
export function startQueueProcessor() {
    if (processorInterval) {
        log('warn', `⚠️ [STT BATCH QUEUE] Procesador ya está corriendo`);
        return;
    }

    const intervalMs = parseInt(process.env.STT_BATCH_POLL_INTERVAL_MS || '500', 10);
    
    processorInterval = setInterval(() => {
        processQueue().catch(err => {
            log('error', `❌ [STT BATCH QUEUE] Error en procesador: ${err.message}`);
        });
    }, intervalMs);

    log('info', `✅ [STT BATCH QUEUE] Procesador iniciado (interval=${intervalMs}ms)`);

    // Nota: Redis pub/sub se maneja de forma diferente en redis v4
    // Por ahora, el polling es suficiente. Si se necesita pub/sub, crear un cliente separado
}

/**
 * Detener procesador de cola
 */
export function stopQueueProcessor() {
    if (processorInterval) {
        clearInterval(processorInterval);
        processorInterval = null;
        log('info', `🛑 [STT BATCH QUEUE] Procesador detenido`);
    }
}
