
import fs from "fs";
import path from "path";
import { sql, poolPromise } from "../../../../lib/db.js";
import { inboundConfig as config } from "../config.js";
import { log } from "../../../../lib/logger.js";
import redis from "../../../../lib/redis.js";

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
            // 🛠️ FIX 5: HARNESS CALL FINALIZER (Anti-Crash)
            if (!session || !session.linkedId) {
                log("warn", "⚠️ [FINALIZE] Finalize skipped: incomplete session context (no linkedId)");
                return;
            }
            if (!businessState) businessState = {};

            const startTime = session.startTime || new Date();
            const endTime = new Date();
            const duration = Math.round((endTime - startTime) / 1000);

            // 1. Generate Conversation Log
            const transcriptText = (session.history || [])
                .map(entry => entry.role === 'user' ? `👤 Usuario: ${entry.content}` : `🤖 Asistente: ${entry.content}`)
                .join('\n');

            // 2. Prepare Paths and Metadata
            const unixTime = Math.floor(startTime.getTime() / 1000);
            
            // 🎯 Captura de DNI para SQL (no se usa en nombre de archivo)
            // Se mantiene para persistencia en base de datos
            let dniValue = businessState.dni;
            if (!dniValue && session.linkedId) {
                try {
                    // Intentar leer identificador consolidado de Redis (puede contener RUT)
                    const redisIdentifier = await redis.get(`session:identifier:${session.linkedId}`);
                    if (redisIdentifier && /^[0-9]+[Kk]?$/.test(redisIdentifier.replace(/[.-]/g, ''))) {
                        dniValue = redisIdentifier;
                        log("info", `🎯 [FINALIZE] DNI recuperado de Redis: ${dniValue}`);
                    }
                } catch (err) {
                    log("warn", `⚠️ [FINALIZE] Error leyendo identificador de Redis para DNI: ${err.message}`);
                }
            }
            
            // Defensive check for ANI/DNIS
            // 📌 NOTA: Se usa ANI en lugar de RUT en el nombre del archivo porque:
            // - El ANI siempre está disponible (número del llamante)
            // - No todos los bots capturan RUT
            // - El ANI es más confiable para identificar la grabación
            const safeAni = session.ani || 'UNKNOWN';
            const safeDnis = session.dnis || 'UNKNOWN';

            // Formato: {linkedId}_{ANI}_{unixTime}.wav
            // Eliminado DNI del nombre de archivo ya que no todos los bots lo capturan
            const finalFileName = `${session.linkedId}_${safeAni}_${unixTime}`;

            const now = new Date();
            // Usar zona horaria local (America/Santiago) en lugar de UTC
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const yyyymmdd = `${year}${month}${day}`;

            // ✅ CANONICAL PATH: /recordings/{domain}/{dnis}/{yyyymmdd}/
            // Cambiado de {linkedId} a {yyyymmdd} para agrupar grabaciones por fecha
            // This ensures NO COLLISION and easy debugging.
            const domain = session.domain || 'default';

            const finalDir = `/opt/telephony-core/recordings/${domain}/${safeDnis}/${yyyymmdd}`;

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
            await this.persistToSql(session, startTime, endTime, safeAni, safeDnis, finalFileName, transcriptText, businessState, audioState);

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
    static async persistToSql(session, startTime, endTime, ani, dnis, finalFileName, transcriptText, businessState, audioState) {
        try {
            // 🎯 MEJORA 5: Protección SQL defensiva - transcripción puede ser vacía
            const safeTranscript = transcriptText || '';
            
            // 🎯 INCREMENTAL RUT: Leer identificador consolidado de Redis si existe
            // Esto permite usar el RUT consolidado incluso si businessState no lo tiene
            let identificador = businessState.identificador;
            if (!identificador && session.linkedId) {
                try {
                    const redisIdentifier = await redis.get(`session:identifier:${session.linkedId}`);
                    if (redisIdentifier) {
                        identificador = redisIdentifier;
                        log("info", `🎯 [FINALIZE] Identificador leído de Redis: ${identificador}`);
                    }
                } catch (err) {
                    log("warn", `⚠️ [FINALIZE] Error leyendo identificador de Redis: ${err.message}`);
                }
            }

            // 🛡️ GUARD: Identificador is mandatory for sp_GuardarGestionLlamada
            // Fallback to sessionId/linkedId if acceptable, otherwise strict check? 
            // User requested: "Ensured essential context variables like ctx.identificador... are initialized".
            // If it's still missing, we skip to avoid crash.

            if (!identificador) {
                log("warn", "⚠️ [FINALIZE] Falta @Identificador. Usando sessionId como fallback.");
            }
            const finalId = identificador || session.sessionId || session.linkedId;

            log("info", `🗄️ [FINALIZE] Registrando gestión en SQL Server (Identificador=${finalId})...`);
            const pool = await poolPromise;
            if (pool) {
                // 🎯 FALLA D FIX: Agregar @DNI_Capturado (requerido por SP)
                // Usar el identificador capturado (RUT) o NULL si no hay
                const dniCapturado = finalId && finalId !== session.sessionId && finalId !== session.linkedId 
                    ? finalId 
                    : null;
                
                // Calcular duración en segundos
                const duracionSegundos = startTime && endTime 
                    ? Math.max(0, Math.floor((endTime.getTime() - startTime.getTime()) / 1000))
                    : 0;
                
                await pool.request()
                    .input('FechaHoraInicio', sql.DateTime, startTime)
                    .input('FechaHoraTermino', sql.DateTime, endTime)
                    .input('DuracionSegundos', sql.Int, duracionSegundos) // 🎯 FIX: Parámetro requerido por SP
                    .input('Agente', sql.NVarChar, 'VoiceBot')
                    .input('ANI', sql.NVarChar, ani)
                    .input('DNIS', sql.NVarChar, dnis)
                    // 🎯 FIX: @RUT_Cliente no es un parámetro del SP - eliminado
                    .input('Identificador', sql.NVarChar, finalId)
                    .input('DNI_Capturado', sql.NVarChar, dniCapturado) // 🎯 FALLA D FIX: Parámetro requerido (contiene el RUT capturado)
                    .input('RutaGrabacion', sql.NVarChar, `${finalFileName}.wav`) // 🎯 FIX: Nombre correcto del parámetro
                    // 🎯 FIX: @Estado_Llamada no es un parámetro del SP - eliminado
                    .input('Transcripcion', sql.NVarChar, safeTranscript || '') // 🎯 MEJORA 5: Protección SQL defensiva (nombre correcto del parámetro)
                    //.input('Resumen_Gestion', sql.NVarChar, businessState.summary || 'Sin resumen') // REMOVED: Likely causing 'too many arguments'
                    //.input('Motivo_Termino', sql.NVarChar, 'Normal') // REMOVED
                    //.input('Id_Llamada_Asterisk', sql.NVarChar, session.linkedId) // REMOVED
                    .execute('sp_GuardarGestionLlamada');

                log("info", `✅ [FINALIZE] Gestión registrada exitosamente en SQL.`);
            } else {
                log("warn", `⚠️ [FINALIZE] No hay conexión SQL disponible.`);
            }
        } catch (sqlErr) {
            log("error", `❌ [FINALIZE] Error SQL: ${sqlErr.message}`);
        }
    }
}
