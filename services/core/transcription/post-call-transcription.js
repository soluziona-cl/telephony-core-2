// =========================================================
// POST-CALL TRANSCRIPTION SERVICE (Layer C)
// =========================================================
// This service listens for 'call.post_processing' events,
// takes the master MixMonitor recording, and generates a
// high-fidelity transcription using OpenAI Whisper.

import fs from 'fs';
import path from 'path';
import redis from '../../../lib/redis.js';
import { log } from '../../../lib/logger.js';
import { OpenAIRealtimeClientV3 } from '../engine/openai-client.js';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const RECS_BASE_PATH = '/opt/telephony-core/recordings';
const MASTER_RECS_PATH = '/var/spool/asterisk/monitor/voicebot';

async function start() {
    log("info", "🚀 [Post-Call] Iniciando servicio de transcripción batch...");

    const openai = new OpenAIRealtimeClientV3();

    // Suscribirse a eventos de post-procesamiento
    const subscriber = redis.duplicate();
    await subscriber.connect();

    await subscriber.subscribe('call.post_processing', async (message) => {
        try {
            const data = JSON.parse(message);
            const { linkedId, ani, dnis, timestamp } = data;

            log("info", `🎯 [Post-Call] Procesando llamada ${linkedId} (${ani} -> ${dnis})`);

            // 1. Esperar a que Asterisk cierre el archivo MixMonitor (grace period)
            setTimeout(async () => {
                await processBatchTranscription(openai, linkedId, ani, dnis, timestamp);
            }, 10000); // 10s de gracia

        } catch (err) {
            log("error", `❌ [Post-Call] Error al procesar mensaje: ${err.message}`);
        }
    });
}

async function processBatchTranscription(openai, linkedId, ani, dnis, timestamp) {
    try {
        const date = new Date(timestamp);
        // Usar zona horaria local (America/Santiago) en lugar de UTC
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const yyyymmdd = `${year}${month}${day}`;

        // 2. Localizar grabación MASTER (Capa A)
        const mixName = `${linkedId}_${ani}_${dnis}_mix.wav`;
        const mixPath = path.join(MASTER_RECS_PATH, yyyymmdd, mixName);

        if (!fs.existsSync(mixPath)) {
            log("warn", `⚠️ [Post-Call] No se encontró grabación master en ${mixPath}`);
            return;
        }

        log("info", `🎙️ [Post-Call] Transcribiendo master WAV: ${mixName}`);

        // 3. Llamar a Whisper (Batch/Offline)
        const fullTranscriptText = await openai.transcribeAudioWithWhisper(mixPath);

        if (!fullTranscriptText) {
            log("warn", `⚠️ [Post-Call] Whisper devolvió transcripción vacía para ${linkedId}`);
            return;
        }

        // 4. Guardar archivo oficial (Capa C)
        const finalDir = path.join(RECS_BASE_PATH, dnis, yyyymmdd);
        if (!fs.existsSync(finalDir)) {
            fs.mkdirSync(finalDir, { recursive: true });
        }

        // Buscamos el nombre de archivo base que usó el engine
        // IdentificadorUnicoDeLlamada_DNI_ANI_unixtime
        const unixTime = Math.floor(date.getTime() / 1000);

        // Como no tenemos el DNI aquí fácilmente (sin consultar Redis/DB), 
        // buscamos archivos que empiecen con ${linkedId} en el directorio final.
        const files = fs.readdirSync(finalDir);
        const baseFile = files.find(f => f.startsWith(linkedId) && f.endsWith('.wav'));

        let finalPath;
        if (baseFile) {
            const baseName = baseFile.replace('.wav', '');
            finalPath = path.join(finalDir, `${baseName}_transcript_full.txt`);
        } else {
            // Fallback si no encontramos el archivo del engine
            finalPath = path.join(finalDir, `${linkedId}_${ani}_${unixTime}_transcript_full.txt`);
        }

        fs.writeFileSync(finalPath, fullTranscriptText);
        log("info", `✅ [Post-Call] Transcripción oficial guardada: ${finalPath}`);

    } catch (err) {
        log("error", `❌ [Post-Call] Error en processBatchTranscription: ${err.message}`);
    }
}

start().catch(err => {
    console.error("Fatal error starting post-call service:", err);
    process.exit(1);
});
