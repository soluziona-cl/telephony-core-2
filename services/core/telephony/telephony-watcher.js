import redis from "../../../lib/redis.js";
import { sql, poolPromise } from "../../../lib/db.js";
import { log } from "../../../lib/logger.js";
import express from "express";

const app = express();
const PORT = process.env.WATCHER_PORT || 3005;

(async () => {
    try {
        const subscriber = redis.duplicate();
        await subscriber.connect();
        log("info", "🔗 Conectado a Redis (Watcher)");

        // --- Función genérica para SPs ---
        async function execSP(procName, params = []) {
            const pool = await poolPromise;
            const request = pool.request();
            for (const p of params) {
                request.input(p.name, p.type, p.value);
            }
            return request.execute(procName);
        }

        // --- RINGING ---
        await subscriber.subscribe("call.ringing", async (message) => {
            try {
                const call = JSON.parse(message);
                log("info", `🟢 RINGING ${call.ani} → ${call.dnis}`);

                await execSP("usp_ActiveCalls_Upsert", [
                    { name: "ChannelId", type: sql.VarChar(64), value: call.channelId },
                    { name: "LinkedId", type: sql.VarChar(64), value: call.linkedId || call.channelId },
                    { name: "Direction", type: sql.VarChar(10), value: call.direction || "UNKNOWN" },
                    { name: "Ani", type: sql.VarChar(32), value: call.ani ?? "UNKNOWN" },
                    { name: "Dnis", type: sql.VarChar(32), value: call.dnis ?? "UNKNOWN" },
                    { name: "State", type: sql.VarChar(20), value: call.state },
                    { name: "Reason", type: sql.VarChar(40), value: "NotAnswered" },
                    { name: "QueueId", type: sql.Int, value: null },
                    { name: "AgentId", type: sql.Int, value: null },
                    { name: "RecordingPath", type: sql.NVarChar(1024), value: null },
                    { name: "StartedAt", type: sql.DateTime2, value: new Date() }
                ]);

                await redis.set(`activeCall:${call.channelId}`, JSON.stringify(call), { EX: 600 });

                // ✅ Estado del agente (SP UNIFICADO)
                await execSP("usp_AgentStatus_SyncByExtension", [
                    { name: "Extension", type: sql.VarChar(10), value: call.ani },
                    { name: "NewStatus", type: sql.VarChar(20), value: "RINGING" },
                    { name: "Event", type: sql.VarChar(50), value: "call.ringing" },
                    { name: "ChannelId", type: sql.VarChar(64), value: call.channelId }
                ]);
            } catch (err) {
                log("error", "❌ Error en call.ringing", err);
            }
        });

        // --- STATE CHANGE ---
        await subscriber.subscribe("call.state", async (message) => {
            try {
                const call = JSON.parse(message);
                log("info", `🔄 STATE ${call.channelId}: ${call.state}`);

                // Actualiza el canal actual
                await execSP("usp_ActiveCalls_Upsert", [
                    { name: "ChannelId", type: sql.VarChar(64), value: call.channelId },
                    { name: "LinkedId", type: sql.VarChar(64), value: call.linkedId || call.channelId },
                    { name: "Direction", type: sql.VarChar(10), value: call.direction || "UNKNOWN" },
                    { name: "Ani", type: sql.VarChar(32), value: call.ani || null },
                    { name: "Dnis", type: sql.VarChar(32), value: call.dnis || null },
                    { name: "State", type: sql.VarChar(20), value: call.state },
                    { name: "Reason", type: sql.VarChar(40), value: call.state === "Up" ? "Connected" : "InProgress" },
                    { name: "QueueId", type: sql.Int, value: null },
                    { name: "AgentId", type: sql.Int, value: null },
                    { name: "RecordingPath", type: sql.NVarChar(1024), value: call.recordingPath || null },
                    { name: "StartedAt", type: sql.DateTime2, value: call.startedAt ? new Date(call.startedAt) : new Date() }
                ]);

                // 🧩 Sincroniza también el LinkedId inverso (A-leg/B-leg)
                if (call.linkedId && call.linkedId !== call.channelId) {
                    await execSP("usp_ActiveCalls_Upsert", [
                        { name: "ChannelId", type: sql.VarChar(64), value: call.linkedId },
                        { name: "LinkedId", type: sql.VarChar(64), value: call.channelId },
                        { name: "Direction", type: sql.VarChar(10), value: call.direction || "UNKNOWN" },
                        { name: "Ani", type: sql.VarChar(32), value: call.ani || null },
                        { name: "Dnis", type: sql.VarChar(32), value: call.dnis || null },
                        { name: "State", type: sql.VarChar(20), value: call.state },
                        { name: "Reason", type: sql.VarChar(40), value: "Connected" },
                        { name: "QueueId", type: sql.Int, value: null },
                        { name: "AgentId", type: sql.Int, value: null },
                        { name: "RecordingPath", type: sql.NVarChar(1024), value: call.recordingPath || null }
                    ]);
                }

                // ✅ Estado del agente cuando conecta (SP UNIFICADO)
                if (call.state === "Up") {
                    await execSP("usp_AgentStatus_SyncByExtension", [
                        { name: "Extension", type: sql.VarChar(10), value: call.ani },
                        { name: "NewStatus", type: sql.VarChar(20), value: "IN_CALL" },
                        { name: "Event", type: sql.VarChar(50), value: "call.state:Up" },
                        { name: "ChannelId", type: sql.VarChar(64), value: call.channelId }
                    ]);
                }
            } catch (err) {
                log("error", "❌ Error en call.state", err);
            }
        });

        // --- CALL REJECTED (Reglas de negocio) ---
        await subscriber.subscribe("call.rejected", async (message) => {
            try {
                const call = JSON.parse(message);
                log("info", `🚫 CALL REJECTED ${call.ani} → ${call.dnis}: ${call.reason}`);

                // Registrar en CallLogs con estado específico
                await execSP("usp_CallLogs_InsertFromActive", [
                    { name: "ChannelId", type: sql.VarChar(64), value: call.channelId },
                    { name: "Status", type: sql.VarChar(32), value: "REJECTED" }
                ]);

                // Limpiar cache Redis
                await redis.del(`activeCall:${call.channelId}`);

                // ✅ Estado del agente (SP UNIFICADO)
                if (call.ani) {
                    await execSP("usp_AgentStatus_SyncByExtension", [
                        { name: "Extension", type: sql.VarChar(10), value: call.ani },
                        { name: "NewStatus", type: sql.VarChar(20), value: "AVAILABLE" },
                        { name: "Event", type: sql.VarChar(50), value: `call.rejected:${call.reason}` },
                        { name: "ChannelId", type: sql.VarChar(64), value: call.channelId }
                    ]);
                    log("info", `📞 Extensión ${call.ani} marcada como AVAILABLE (rejected: ${call.reason})`);
                }

            } catch (err) {
                log("error", "❌ Error en call.rejected", err);
            }
        });

        // --- HANGUP ---
        await subscriber.subscribe("call.hangup", async (message) => {
            try {
                const call = JSON.parse(message);
                log("info", `🔴 HANGUP ${call.channelId}`);

                // --- Bloque de grabación (si se incluye recordingPath) ---
                if (call.recordingPath) {
                    try {
                        log("info", `🎧 Grabación disponible para ${call.channelId}: ${call.recordingPath}`);

                        // 1️⃣ Actualizar registro activo con la ruta
                        await execSP("usp_ActiveCalls_UpdateRecordingPath", [
                            { name: "ChannelId", type: sql.VarChar(64), value: call.channelId },
                            { name: "RecordingPath", type: sql.NVarChar(1024), value: call.recordingPath },
                        ]);

                        // 2️⃣ (opcional) actualizar directamente en CallLogs si existe
                        await execSP("usp_CallLogs_UpdateRecordingPath", [
                            { name: "ChannelId", type: sql.VarChar(64), value: call.channelId },
                            { name: "RecordingPath", type: sql.NVarChar(1024), value: call.recordingPath },
                        ]);

                    } catch (err) {
                        log("warn", "No se pudo actualizar RecordingPath en SQL", err.message);
                    }
                }

                // 1️⃣ Registrar en CallLogs
                await execSP("usp_CallLogs_InsertFromActive", [
                    { name: "ChannelId", type: sql.VarChar(64), value: call.channelId },
                    { name: "Status", type: sql.VarChar(32), value: "ENDED" }
                ]);

                // 2️⃣ Eliminar de cache Redis
                await redis.del(`activeCall:${call.channelId}`);

                // ✅ 3️⃣ USAR SP UNIFICADO PARA HANGUP
                await execSP("usp_AgentStatus_SyncOnHangup", [
                    { name: "AgentId", type: sql.Int, value: call.agentId || null },
                    { name: "AgentExtension", type: sql.VarChar(10), value: call.ani || null }
                ]);

                log("info", `✅ Estado del agente sincronizado a AVAILABLE (ChannelId: ${call.channelId})`);

            } catch (err) {
                log("error", "❌ Error en call.hangup", err);
            }
        });


        log("info", "👂 Watcher escuchando eventos call.* y actualizando agentes vía SPs");
    } catch (err) {
        log("error", "❌ Error inicializando Telephony Watcher", err);
    }


})();

// --- ENDPOINT STATUS ---
app.get("/status", (req, res) => {
    res.json({ service: "telephony-watcher", status: "ok", timestamp: new Date().toISOString() });
});

// --- ENDPOINT DIAGNOSTICS ---
app.get("/diagnostics", async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().execute("usp_AgentStatus_DiagnosticReport");

        res.json({
            service: "telephony-watcher",
            timestamp: new Date().toISOString(),
            agents: result.recordsets[0],
            summary: result.recordsets[1][0]
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ENDPOINT SYNC ORPHANS ---
app.post("/sync-orphans", async (req, res) => {
    try {
        const pool = await poolPromise;
        await pool.request().execute("usp_AgentStatus_SyncOrphans");

        res.json({
            success: true,
            message: "Sincronización de agentes huérfanos completada",
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => log("info", `📡 Telephony Watcher activo en puerto ${PORT}`));
