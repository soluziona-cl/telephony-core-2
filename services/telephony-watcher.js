import redis from "../lib/redis.js";
import { sql, poolPromise } from "../lib/db.js";
import { log } from "../lib/logger.js";
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
                    { name: "Direction", type: sql.VarChar(10), value: call.direction || "IN" },
                    { name: "Ani", type: sql.VarChar(32), value: call.ani ?? "UNKNOWN" },
                    { name: "Dnis", type: sql.VarChar(32), value: call.dnis ?? "UNKNOWN" },
                    { name: "State", type: sql.VarChar(20), value: call.state },
                    { name: "QueueId", type: sql.Int, value: null },
                    { name: "AgentId", type: sql.Int, value: null },
                    { name: "RecordingPath", type: sql.NVarChar(1024), value: null }
                ]);

                await redis.set(`activeCall:${call.channelId}`, JSON.stringify(call), { EX: 600 });

                // 🔄 Estado del agente (SP)
                await execSP("usp_AgentStatus_ChangeByExtension", [
                    { name: "Extension", type: sql.VarChar(10), value: call.ani },
                    { name: "NewStatus", type: sql.VarChar(20), value: "RINGING" }
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

                await execSP("usp_ActiveCalls_Upsert", [
                    { name: "ChannelId", type: sql.VarChar(64), value: call.channelId },
                    { name: "Direction", type: sql.VarChar(10), value: "IN" },
                    { name: "Ani", type: sql.VarChar(32), value: call.ani || null },
                    { name: "Dnis", type: sql.VarChar(32), value: call.dnis || null },
                    { name: "State", type: sql.VarChar(20), value: call.state },
                    { name: "QueueId", type: sql.Int, value: null },
                    { name: "AgentId", type: sql.Int, value: null },
                    { name: "RecordingPath", type: sql.NVarChar(1024), value: null }
                ]);

                if (call.state === "Up") {
                    await execSP("usp_AgentStatus_ChangeByExtension", [
                        { name: "Extension", type: sql.VarChar(10), value: call.ani },
                        { name: "NewStatus", type: sql.VarChar(20), value: "IN_CALL" }
                    ]);
                }
            } catch (err) {
                log("error", "❌ Error en call.state", err);
            }
        });

        // --- HANGUP ---
        await subscriber.subscribe("call.hangup", async (message) => {
            try {
                const call = JSON.parse(message);
                log("info", `🔴 HANGUP ${call.channelId}`);

                // 1️⃣ Registrar en CallLogs
                await execSP("usp_CallLogs_InsertFromActive", [
                    { name: "ChannelId", type: sql.VarChar(64), value: call.channelId },
                    { name: "Status", type: sql.VarChar(32), value: "ENDED" }
                ]);

                // 2️⃣ Eliminar de cache Redis
                await redis.del(`activeCall:${call.channelId}`);

                // 3️⃣ Recuperar AgentId si existe
                const pool = await poolPromise;
                const result = await pool.request()
                    .input("ChannelId", sql.VarChar(64), call.channelId)
                    .query("SELECT TOP 1 AgentId FROM ActiveCalls WHERE ChannelId = @ChannelId");

                const agentId = result.recordset?.[0]?.AgentId || null;

                // 4️⃣ Actualizar estado del agente (disponible)
                if (agentId) {
                    await execSP("usp_AgentStatus_Change", [
                        { name: "AgentId", type: sql.Int, value: agentId },
                        { name: "NewStatus", type: sql.VarChar(20), value: "AVAILABLE" }
                    ]);
                    log("info", `👤 Agente ${agentId} marcado como AVAILABLE`);
                } else if (call.ani) {
                    await execSP("usp_AgentRuntime_UpsertByExtension", [
                        { name: "Extension", type: sql.VarChar(10), value: call.ani },
                        { name: "NewStatus", type: sql.VarChar(20), value: "AVAILABLE" },
                        { name: "Event", type: sql.VarChar(50), value: "call.hangup" },
                        { name: "ChannelId", type: sql.VarChar(64), value: call.channelId },
                    ]);

                    log("info", `📞 Extensión ${call.ani} marcada como AVAILABLE`);
                }

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

app.listen(PORT, () => log("info", `📡 Telephony Watcher activo en puerto ${PORT}`));
