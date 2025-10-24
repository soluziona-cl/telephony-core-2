// =============================================
// 🔐 AGENTE LOGIN/LOGOUT TRACKER
// Detecta conexiones/desconexiones de extensiones PJSIP
// =============================================

import AriClient from "ari-client";
import { sql, poolPromise } from "../lib/db.js";
import redis from "../lib/redis.js";
import { log } from "../lib/logger.js";
import dotenv from "dotenv";
dotenv.config();

// Función para ejecutar SPs
async function execSP(procName, params = []) {
    const pool = await poolPromise;
    const request = pool.request();
    for (const p of params) {
        request.input(p.name, p.type, p.value);
    }
    return request.execute(procName);
}

// =============================================
// 🎯 MÉTODO 1: Polling de Endpoints PJSIP
// =============================================
async function pollPJSIPEndpoints(ari) {
    try {
        const endpoints = await ari.endpoints.list();
        const pjsipEndpoints = endpoints.filter(ep => ep.technology === 'PJSIP');

        for (const ep of pjsipEndpoints) {
            const extension = ep.resource; // ej: "1001"
            const isOnline = ep.state === 'online' || ep.state === 'connected';

            // Verificar estado anterior en Redis
            const lastState = await redis.get(`agent:${extension}:online`);
            const wasOnline = lastState === 'true';

            if (isOnline && !wasOnline) {
                // 🟢 AGENTE SE CONECTÓ
                log("info", `🟢 Agente ${extension} CONECTADO a Asterisk`);

                await execSP("usp_AgentStatus_SyncByExtension", [
                    { name: "Extension", type: sql.VarChar(10), value: extension },
                    { name: "NewStatus", type: sql.VarChar(20), value: "AVAILABLE" },
                    { name: "Event", type: sql.VarChar(50), value: "agent.login" },
                    { name: "ChannelId", type: sql.VarChar(64), value: null }
                ]);

                // Marcar como logueado
                await execSP("usp_Agent_SetLoginStatus", [
                    { name: "Extension", type: sql.VarChar(10), value: extension },
                    { name: "IsLoggedIn", type: sql.Bit, value: 1 }
                ]);

                await redis.set(`agent:${extension}:online`, 'true', { EX: 120 });

                // Publicar evento
                await redis.publish('agent.login', JSON.stringify({
                    extension,
                    loginAt: new Date().toISOString()
                }));

            } else if (!isOnline && wasOnline) {
                // 🔴 AGENTE SE DESCONECTÓ
                log("info", `🔴 Agente ${extension} DESCONECTADO de Asterisk`);

                await execSP("usp_AgentStatus_SyncByExtension", [
                    { name: "Extension", type: sql.VarChar(10), value: extension },
                    { name: "NewStatus", type: sql.VarChar(20), value: "OFFLINE" },
                    { name: "Event", type: sql.VarChar(50), value: "agent.logout" },
                    { name: "ChannelId", type: sql.VarChar(64), value: null }
                ]);

                // Marcar como deslogueado
                await execSP("usp_Agent_SetLoginStatus", [
                    { name: "Extension", type: sql.VarChar(10), value: extension },
                    { name: "IsLoggedIn", type: sql.Bit, value: 0 }
                ]);

                await redis.del(`agent:${extension}:online`);

                // Publicar evento
                await redis.publish('agent.logout', JSON.stringify({
                    extension,
                    logoutAt: new Date().toISOString()
                }));

            } else if (isOnline) {
                // Renovar TTL (heartbeat)
                await redis.expire(`agent:${extension}:online`, 120);
            }
        }

    } catch (err) {
        log("error", "Error en pollPJSIPEndpoints", err.message);
    }
}

// =============================================
// 🚀 INICIALIZAR TRACKER
// =============================================
AriClient.connect(
    process.env.ARI_URL,
    process.env.ARI_USER,
    process.env.ARI_PASS,
    async (err, ari) => {
        if (err) {
            console.error("❌ Error al conectar con ARI:", err);
            return;
        }

        log("info", "✅ Agent Tracker conectado a Asterisk ARI");

        // Polling cada 10 segundos
        setInterval(() => pollPJSIPEndpoints(ari), 10000);

        // Primera ejecución inmediata
        pollPJSIPEndpoints(ari);

        log("info", "👀 Monitoreando login/logout de agentes PJSIP");
    }
);