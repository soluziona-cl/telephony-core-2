
import fs from "fs";
import path from "path";
import { sql, poolPromise } from "../../../../lib/db.js";
import { inboundConfig as config } from "../config.js";
import { log } from "../../../../lib/logger.js";

/**
 * Service responsible for finalizing the call, saving logs, managing recordings,
 * and persisting data to SQL Server.
 */
export class CallFinalizer {

    /**
     * Executes the full finalization process for a call session.
     * @param {Object} ari - ARI client instance (used for channel id if needed)
     * @param {Object} channel - ARI channel instance
     * @param {Object} session - Session context object (ani, dnis, linkedId, startTime, etc.)
     * @param {Object} audioState - Audio state object (successfulTurns, etc.)
     * @param {Object} businessState - Business domain state (patient, dni, specialty, etc.)
     */
    static async finalize(ari, channel, session, audioState, businessState) {
        try {
            const endTime = new Date();
            const duration = Math.round((endTime - session.startTime) / 1000);

            // 1. Generate Conversation Log
            const transcriptText = session.history
                .map(entry => entry.role === 'user' ? `👤 Usuario: ${entry.content}` : `🤖 Asistente: ${entry.content}`)
                .join('\n');

            // 2. Prepare Paths and Metadata
            const unixTime = Math.floor(session.startTime.getTime() / 1000);
            // Defensive check for DNI/ANI
            const safeDni = businessState.dni ? businessState.dni.replace(/[^0-9Kk]/g, '') : 'UNKNOWN';
            const safeAni = session.ani || 'UNKNOWN';
            const safeDnis = session.dnis || 'UNKNOWN';

            const finalFileName = `${session.linkedId}_${safeDni}_${safeAni}_${unixTime}`;

            const now = new Date();
            const yyyymmdd = now.toISOString().split('T')[0].replace(/-/g, '');
            const finalDir = `/opt/telephony-core/recordings/${safeDnis}/${yyyymmdd}`;

            log("info", `📂 [FINALIZE] Preparando almacenamiento en ${finalDir}`);

            if (!fs.existsSync(finalDir)) {
                fs.mkdirSync(finalDir, { recursive: true });
            }

            const finalWavPath = path.join(finalDir, `${finalFileName}.wav`);
            const finalTxtPath = path.join(finalDir, `${finalFileName}_conversation_log.txt`);

            // 3. Save Conversation Log (Layer B)
            fs.writeFileSync(finalTxtPath, transcriptText);
            log("info", `📄 [FINALIZE] Log de conversación guardado: ${finalTxtPath}`);

            // 4. Move/Copy MASTER Recording (MixMonitor)
            const mixName = `${session.linkedId}_${safeAni}_${safeDnis}_mix.wav`;
            const mixPath = path.join(`/var/spool/asterisk/monitor/voicebot/${yyyymmdd}`, mixName);

            // Async copy to avoid blocking immediately
            setTimeout(async () => {
                this.handleRecordingCopy(mixPath, finalWavPath, session.linkedId, safeAni, safeDnis);
            }, 5000);

            // 5. Persist to SQL Server
            await this.persistToSql(session, endTime, safeAni, safeDnis, finalFileName, transcriptText, businessState, audioState);

        } catch (err) {
            log("error", `❌ [FINALIZE] Error fatal en CallFinalizer: ${err.message}`);
        }
    }

    /**
     * Handles the logic of finding and copying the recording file.
     */
    static async handleRecordingCopy(mixPath, finalWavPath, linkedId, ani, dnis) {
        log("info", `🔍 [FINALIZE] Buscando grabación master (MixMonitor) en: ${mixPath}`);

        if (fs.existsSync(mixPath)) {
            try {
                fs.copyFileSync(mixPath, finalWavPath);
                log("info", `🎙️ [FINALIZE] Grabación master copiada a ruta final: ${finalWavPath}`);
            } catch (copyErr) {
                log("error", `❌ [FINALIZE] Error copiando archivo master: ${copyErr.message}`);
            }
        } else {
            log("warn", `⚠️ [FINALIZE] No se encontró el archivo master ${mixPath}`);

            // Fallback: search for old ARI recording path
            const originalName = `${linkedId}_${ani}_${dnis}`.replace(/[^0-9A-Za-z_+]/g, "_");
            const originalPath = path.join(config.paths.recordings || '/var/spool/asterisk/recording', `${originalName}.wav`);

            if (fs.existsSync(originalPath)) {
                log("info", `🔄 [FINALIZE] Fallback a grabación ARI: ${originalPath}`);
                try {
                    fs.copyFileSync(originalPath, finalWavPath);
                } catch (e) { }
            }
        }
    }

    /**
     * Executes the stored procedure to save call details.
     */
    static async persistToSql(session, endTime, ani, dnis, finalFileName, transcriptText, businessState, audioState) {
        try {
            // 🛡️ GUARD: Identificador is mandatory for sp_GuardarGestionLlamada
            const identificador = businessState.identificador || session.sessionId; // Fallback to sessionId/linkedId if acceptable, otherwise strict check? 
            // User requested: "Ensured essential context variables like ctx.identificador... are initialized".
            // If it's still missing, we skip to avoid crash.

            if (!identificador) {
                log("warn", "⚠️ [FINALIZE] Falta @Identificador (businessState.identificador). Omitiendo guardado SQL para evitar error.");
                return;
            }

            log("info", `🗄️ [FINALIZE] Registrando gestión en SQL Server (Identificador=${identificador})...`);
            const pool = await poolPromise;
            if (pool) {
                await pool.request()
                    .input('FechaHoraInicio', sql.DateTime, session.startTime)
                    .input('FechaHoraTermino', sql.DateTime, endTime)
                    .input('Agente', sql.NVarChar, 'VoiceBot')
                    .input('ANI', sql.NVarChar, ani)
                    .input('DNIS', sql.NVarChar, dnis)
                    .input('RUT_Cliente', sql.NVarChar, businessState.dni || 'UNKNOWN') // Use DNI if validated, else UNKNOWN
                    .input('Identificador', sql.NVarChar, identificador) // ✅ ADDED
                    .input('Nombre_Archivo_Grabacion', sql.NVarChar, `${finalFileName}.wav`)
                    .input('Estado_Llamada', sql.NVarChar, session.terminated ? 'Terminated' : 'Completed')
                    .input('Transcription_Log', sql.NVarChar, transcriptText)
                    .input('Resumen_Gestion', sql.NVarChar, businessState.summary || 'Sin resumen')
                    .input('Motivo_Termino', sql.NVarChar, 'Normal') // Could be enhanced with termination reason
                    .input('Id_Llamada_Asterisk', sql.NVarChar, session.linkedId)
                    .execute('sp_GuardarGestionLlamada'); // Using the transversal SP name

                log("info", `✅ [FINALIZE] Gestión registrada exitosamente en SQL.`);
            } else {
                log("warn", `⚠️ [FINALIZE] No hay conexión SQL disponible.`);
            }
        } catch (sqlErr) {
            log("error", `❌ [FINALIZE] Error SQL: ${sqlErr.message}`);
        }
    }
}
