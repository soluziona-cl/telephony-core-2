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

        // --- STATE CHANGE - VERSIÓN MEJORADA ---
        await subscriber.subscribe("call.state", async (message) => {
            try {
                const call = JSON.parse(message);
                log("info", `🔄 STATE ${call.channelId}: ${call.state} [Agent: ${call.agentId || 'N/A'}]`);

                // 🆕 DETECCIÓN MEJORADA DE AGENTE
                let agentExtension = null;
                
                // Prioridad 1: agentId explícito del evento
                if (call.agentId) {
                    agentExtension = call.agentId;
                }
                // Prioridad 2: ANI para outbound, DNIS para inbound
                else if (call.direction === "OUTBOUND" && call.ani && call.ani.length <= 4) {
                    agentExtension = call.ani;
                }
                else if (call.direction === "INBOUND" && call.dnis && call.dnis.length <= 4) {
                    agentExtension = call.dnis;
                }

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
                    { name: "AgentId", type: sql.Int, value: agentExtension ? parseInt(agentExtension) : null },
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
                        { name: "AgentId", type: sql.Int, value: agentExtension ? parseInt(agentExtension) : null },
                        { name: "RecordingPath", type: sql.NVarChar(1024), value: call.recordingPath || null }
                    ]);
                }

                // ✅ Estado del agente cuando conecta
                if (call.state === "Up" && agentExtension) {
                    await execSP("usp_AgentStatus_SyncByExtension", [
                        { name: "Extension", type: sql.VarChar(10), value: agentExtension },
                        { name: "NewStatus", type: sql.VarChar(20), value: "IN_CALL" },
                        { name: "Event", type: sql.VarChar(50), value: "call.state:Up" },
                        { name: "ChannelId", type: sql.VarChar(64), value: call.channelId }
                    ]);
                    
                    log("info", `✅ Agente ${agentExtension} marcado como IN_CALL`);
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

        // --- AGENT STATUS ---
        await subscriber.subscribe("agent.status", async (message) => {
            try {
                const agentEvent = JSON.parse(message);
                log("info", `👤 AGENT STATUS: ${agentEvent.agentId} -> ${agentEvent.status}`);

                // 🆕 ACTUALIZAR DIRECTAMENTE EL ESTADO DEL AGENTE
                await execSP("usp_AgentStatus_UpdateByExtension", [
                    { name: "Extension", type: sql.VarChar(10), value: agentEvent.agentId },
                    { name: "NewStatus", type: sql.VarChar(20), value: agentEvent.status.toUpperCase() },
                    { name: "ChannelId", type: sql.VarChar(64), value: agentEvent.channelId || null },
                    { name: "EventSource", type: sql.VarChar(50), value: "agent.status" }
                ]);

                log("info", `✅ Estado de agente ${agentEvent.agentId} actualizado a ${agentEvent.status}`);

            } catch (err) {
                log("error", "❌ Error en agent.status", err);
            }
        });

        // --- RULE APPLIED (Reglas de negocio aplicadas) ---
        await subscriber.subscribe("rule.applied", async (message) => {
            try {
                const ruleEvent = JSON.parse(message);
                log("info", `⚡ REGLA APLICADA: ${ruleEvent.type} para ${ruleEvent.ani}`);

                // Actualizar estado del agente si es relevante
                if (ruleEvent.type === "vip") {
                    await execSP("usp_AgentStatus_SyncByExtension", [
                        { name: "Extension", type: sql.VarChar(10), value: ruleEvent.ani },
                        { name: "NewStatus", type: sql.VarChar(20), value: "HANDLING_VIP" },
                        { name: "Event", type: sql.VarChar(50), value: "rule.applied:vip" },
                        { name: "ChannelId", type: sql.VarChar(64), value: ruleEvent.linkedId }
                    ]);
                }

            } catch (err) {
                log("error", "❌ Error en rule.applied", err);
            }
        });

        // --- HANGUP - VERSIÓN MEJORADA CON MÁS LOGS ---
        await subscriber.subscribe("call.hangup", async (message) => {
            try {
                const call = JSON.parse(message);
                log("info", `🔴 HANGUP DEBUG - Canal: ${call.channelId}, AgentId: ${call.agentId || 'NULL'}, ANI: ${call.ani}, DNIS: ${call.dnis}, Reason: ${call.reason}`);

                // 🆕 BUSCAR AGENTE ASOCIADO AL CANAL
                let agentExtension = null;
                
                // Método 1: Desde Redis (referencia directa)
                const agentFromRedis = await redis.get(`agent:channel:${call.channelId}`);
                if (agentFromRedis) {
                    agentExtension = agentFromRedis;
                    log("info", `🔍 Agente ${agentExtension} recuperado desde Redis para canal ${call.channelId}`);
                }
                
                // Método 2: Desde el evento call.hangup
                if (!agentExtension && call.agentId) {
                    agentExtension = call.agentId;
                    log("info", `🔍 Agente ${agentExtension} obtenido del evento call.hangup`);
                }
                
                log("debug", `🔍 Detección de agente - Redis: ${agentFromRedis || 'NULL'}, Event: ${call.agentId || 'NULL'}, Final: ${agentExtension || 'NULL'}`);
                
                // Método 3: Lógica de detección por ANI/DNIS
                if (!agentExtension) {
                    if (call.direction === "OUTBOUND" && call.ani && call.ani.length <= 4) {
                        agentExtension = call.ani;
                        log("info", `🔍 Agente ${agentExtension} detectado por ANI outbound`);
                    } else if (call.direction === "INBOUND" && call.dnis && call.dnis.length <= 4) {
                        agentExtension = call.dnis;
                        log("info", `🔍 Agente ${agentExtension} detectado por DNIS inbound`);
                    }
                }

                // 🆕 VALIDAR Y RECUPERAR DATOS FALTANTES (código existente mejorado)
                if (!call.ani || !call.dnis) {
                    log("warn", `⚠️ Datos incompletos en hangup, intentando recuperar: ${call.channelId}`);
                    
                    const activeCallData = await redis.get(`activeCall:${call.channelId}`);
                    if (activeCallData) {
                        const storedCall = JSON.parse(activeCallData);
                        call.ani = call.ani || storedCall.ani || "";
                        call.dnis = call.dnis || storedCall.dnis || "";
                        call.direction = call.direction || storedCall.direction || "UNKNOWN";
                        
                        // 🆕 Recuperar también agentId si existe
                        if (!agentExtension && storedCall.agentId) {
                            agentExtension = storedCall.agentId.toString();
                        }
                    }
                }

                // 🆕 SI AÚN NO HAY DATOS, BUSCAR POR LINKEDID
                if ((!call.ani || !call.dnis) && call.linkedId) {
                    const linkedChannels = await redis.keys(`activeCall:*`);
                    for (const key of linkedChannels) {
                        const data = await redis.get(key);
                        if (data && data.includes(call.linkedId)) {
                            const linkedCall = JSON.parse(data);
                            if (linkedCall.ani && linkedCall.dnis) {
                                call.ani = call.ani || linkedCall.ani;
                                call.dnis = call.dnis || linkedCall.dnis;
                                call.direction = call.direction || linkedCall.direction;
                                
                                // 🆕 Recuperar también agentId si existe
                                if (!agentExtension && linkedCall.agentId) {
                                    agentExtension = linkedCall.agentId.toString();
                                }
                                break;
                            }
                        }
                    }
                }

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
                await redis.del(`agent:channel:${call.channelId}`); // 🆕 Limpiar referencia

                // 🆕 3️⃣ ACTUALIZAR AGENTE SI SE DETECTÓ
                if (agentExtension) {
                    log("info", `🔄 Actualizando agente ${agentExtension} a AVAILABLE...`);
                    log("debug", `🔄 Ejecutando usp_AgentStatus_SyncOnHangup para agente ${agentExtension}, canal ${call.channelId}`);
                    
                    // 🆕 VALIDAR QUE EL AGENTE EXISTE ANTES DE ACTUALIZAR
                    try {
                        const agentCheck = await execSP("usp_AgentStatus_GetByExtension", [
                            { name: "Extension", type: sql.VarChar(10), value: agentExtension }
                        ]);
                        
                        if (agentCheck.recordset.length === 0) {
                            log("warn", `⚠️ Agente ${agentExtension} no existe en la base de datos - saltando actualización`);
                        } else {
                            await execSP("usp_AgentStatus_SyncOnHangup", [
                                { name: "ChannelId", type: sql.VarChar(64), value: call.channelId },
                                { name: "NewStatus", type: sql.VarChar(20), value: "AVAILABLE" },
                                { name: "AgentExtension", type: sql.VarChar(10), value: agentExtension }
                            ]);
                        }
                    } catch (validationErr) {
                        log("error", `❌ Error validando agente ${agentExtension}:`, validationErr.message);
                        // Intentar actualización de todas formas
                        try {
                            await execSP("usp_AgentStatus_SyncOnHangup", [
                                { name: "ChannelId", type: sql.VarChar(64), value: call.channelId },
                                { name: "NewStatus", type: sql.VarChar(20), value: "AVAILABLE" },
                                { name: "AgentExtension", type: sql.VarChar(10), value: agentExtension }
                            ]);
                        } catch (updateErr) {
                            log("error", `❌ Error actualizando agente ${agentExtension}:`, updateErr.message);
                        }
                    }
                    
                    // 🆕 VERIFICAR QUE SE ACTUALIZÓ CORRECTAMENTE
                    try {
                        const verificationResult = await execSP("usp_AgentStatus_GetByExtension", [
                            { name: "Extension", type: sql.VarChar(10), value: agentExtension }
                        ]);
                        
                        if (verificationResult.recordset.length > 0) {
                            const currentStatus = verificationResult.recordset[0].Status;
                            if (currentStatus === "AVAILABLE") {
                                log("info", `✅ Agente ${agentExtension} actualizado correctamente a AVAILABLE`);
                            } else {
                                log("error", `❌ Agente ${agentExtension} NO se actualizó a AVAILABLE. Estado actual: ${currentStatus}`);
                            }
                        } else {
                            log("warn", `⚠️ No se pudo verificar estado del agente ${agentExtension}`);
                        }
                    } catch (verifyErr) {
                        log("warn", `⚠️ Error verificando estado del agente ${agentExtension}:`, verifyErr.message);
                    }
                    
                    // Limpiar referencia Redis
                    await redis.del(`agent:channel:${call.channelId}`);
                    
                } else {
                    log("warn", `⚠️ No se pudo identificar agente para actualizar en hangup: ${call.channelId}`);
                    log("debug", `ℹ️ Datos disponibles - ANI: ${call.ani}, DNIS: ${call.dnis}, Direction: ${call.direction}, AgentId: ${call.agentId}`);
                    
                    // 🆕 FALLBACK MEJORADO: Buscar agentes huérfanos por linkedId
                    if (call.linkedId) {
                        log("info", `🧹 Ejecutando limpieza de agentes huérfanos para linkedId: ${call.linkedId}`);
                        await execSP("usp_AgentStatus_CleanupOrphaned", [
                            { name: "LinkedId", type: sql.VarChar(64), value: call.linkedId }
                        ]);
                    }
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

// --- ENDPOINT AGENT STATUS ---
app.get("/agent-status/:extension", async (req, res) => {
    try {
        const { extension } = req.params;
        const pool = await poolPromise;
        
        const result = await execSP("usp_AgentStatus_GetByExtension", [
            { name: "Extension", type: sql.VarChar(10), value: extension }
        ]);

        if (result.recordset.length > 0) {
            res.json({
                agent: result.recordset[0],
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(404).json({ error: "Agente no encontrado" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ENDPOINT FORCE SYNC AGENT ---
app.post("/agent-sync/:extension", async (req, res) => {
    try {
        const { extension } = req.params;
        const { status = "AVAILABLE" } = req.body;
        
        await execSP("usp_AgentStatus_SyncByExtension", [
            { name: "Extension", type: sql.VarChar(10), value: extension },
            { name: "NewStatus", type: sql.VarChar(20), value: status },
            { name: "Event", type: sql.VarChar(50), value: "manual.sync" },
            { name: "ChannelId", type: sql.VarChar(64), value: null }
        ]);

        res.json({
            success: true,
            message: `Agente ${extension} sincronizado a ${status}`,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ENDPOINT AGENT LIST ---
app.get("/agents", async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().execute("usp_AgentStatus_GetAll");

        res.json({
            agents: result.recordset,
            count: result.recordset.length,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ENDPOINT AGENT FORCE AVAILABLE ---
app.post("/agent-force-available/:extension", async (req, res) => {
    try {
        const { extension } = req.params;
        
        // Forzar estado AVAILABLE y limpiar canal asociado
        await execSP("usp_AgentStatus_ForceAvailable", [
            { name: "Extension", type: sql.VarChar(10), value: extension }
        ]);

        res.json({
            success: true,
            message: `Agente ${extension} forzado a AVAILABLE`,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => log("info", `📡 Telephony Watcher activo en puerto ${PORT}`));