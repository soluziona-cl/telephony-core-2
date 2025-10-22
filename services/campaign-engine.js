import { sql, poolPromise } from "../lib/db.js";
import redis from "../lib/redis.js";
import { log } from "../lib/logger.js";
import dotenv from "dotenv";
dotenv.config();

log("info", "🚀 Campaign Engine iniciado");

// KPI loop
setInterval(async () => {
    try {
        const pool = await poolPromise;
        const kpi = await pool.request().execute("usp_KPI_10Min");
        log("info", "📈 KPI actualizado", kpi.recordset);
    } catch (err) {
        log("error", "Error obteniendo KPI", err);
    }
}, 15000);

// eventos de Redis
redis.subscribe("call.hangup", async (msg) => {
    const data = JSON.parse(msg);
    log("info", `☎️ Llamada finalizada detectada por Campaign Engine`, data);
}).catch(err => {
    log("error", "Error subscribing to Redis events", err.message);
});
