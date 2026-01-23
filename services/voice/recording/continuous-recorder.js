/**
 * 🎙️ CONTINUOUS RECORDER - Grabación continua del Snoop (audio solo usuario)
 * 
 * Estrategia: Grabar el Snoop RX (spy=in) desde inicio hasta hangup
 * sin detener, sin reiniciar, sin depender del dominio.
 */

import fs from "node:fs";
import path from "node:path";
import { log } from "../../../lib/logger.js";

export class ContinuousRecorder {
    constructor({ ari, recordingsDir }) {
        this.ari = ari;
        this.recordingsDir = recordingsDir || "/opt/telephony-core/recordings";
    }

    /**
     * Iniciar grabación continua del Snoop
     * IMPORTANTE: El Snoop YA debe estar creado y NO debe estar en un bridge cuando se graba
     * @param {Object} params
     * @param {string} params.callId - ID de la llamada
     * @param {string} params.snoopChannelId - ID del canal Snoop (ya creado)
     * @returns {Promise<{snoopChannelId: string, recordingName: string, recordingPath: string, recording: Object}>}
     */
    async start({ callId, snoopChannelId }) {
        if (!snoopChannelId) {
            throw new Error("snoopChannelId es requerido - el Snoop debe estar creado antes de grabar");
        }

        log("info", `🎙️ [RECORDER] Iniciando grabación continua del Snoop ${snoopChannelId}`);

        // 1) Activar detección de voz en snoop (si no está ya activado)
        try {
            await this.ari.channels.setChannelVar({
                channelId: snoopChannelId,
                variable: "TALK_DETECT(set)",
                value: "on",
            });
            log("info", `✅ [RECORDER] TALK_DETECT activado en Snoop ${snoopChannelId}`);
        } catch (err) {
            // fallback silencioso si esa var no existe o ya está activado
            log("debug", `[RECORDER] TALK_DETECT en Snoop (puede estar ya activado): ${err.message}`);
        }

        // 2) Iniciar grabación continua (WAV) - CRÍTICO: antes de agregar a bridge
        const name = `call_${callId}`;
        const outPath = path.join(this.recordingsDir, `${name}.wav`);

        if (!fs.existsSync(this.recordingsDir)) {
            fs.mkdirSync(this.recordingsDir, { recursive: true });
        }

        // 🎯 CRÍTICO: Grabar ANTES de agregar el Snoop a cualquier bridge
        // Asterisk no permite grabar un canal que ya está en un bridge
        const liveRec = await this.ari.channels.record({
            channelId: snoopChannelId,
            name,               // Asterisk guarda por "name"
            format: "wav",
            beep: false,
            ifExists: "overwrite",
            maxDurationSeconds: 86400, // 24 horas máximo
            maxSilenceSeconds: 0,     // Sin límite de silencio
        });

        log("info", `🎙️ [RECORDER] Grabación continua iniciada: ${name} → ${outPath}`, {
            snoopChannelId,
            recordingName: name
        });

        return {
            snoopChannelId: snoopChannelId,
            recordingName: name,
            recordingPath: outPath,
            recording: liveRec
        };
    }

    /**
     * Detener grabación continua
     * @param {Object} params
     * @param {Object} params.recording - Objeto de grabación de ARI o metadata con recordingName
     */
    async stop({ recording }) {
        if (!recording) {
            log("warn", `⚠️ [RECORDER] No hay grabación para detener`);
            return;
        }

        try {
            // Si recording tiene método stop (objeto de ARI)
            if (typeof recording.stop === 'function') {
                await recording.stop();
                log("info", `🛑 [RECORDER] Grabación detenida (objeto ARI)`);
            } 
            // Si recording tiene recordingName (metadata)
            else if (recording.name || recording.recordingName) {
                const recName = recording.name || recording.recordingName;
                await this.ari.recordings.stop({ recordingName: recName });
                log("info", `🛑 [RECORDER] Grabación detenida: ${recName}`);
            }
            else {
                log("warn", `⚠️ [RECORDER] Formato de recording no reconocido`);
            }
        } catch (err) {
            if (!err.message.includes("not found") && !err.message.includes("does not exist")) {
                log("warn", `⚠️ [RECORDER] Error deteniendo grabación: ${err.message}`);
            }
        }
    }
}
