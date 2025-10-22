import { createClient } from "redis";
import { log } from "./logger.js";
import dotenv from "dotenv";
import path from "path";

// 🔧 Forzar carga absoluta del .env
dotenv.config({ path: path.resolve('/opt/telephony-core/.env') });

console.log("🌍 Config Redis:", {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
});

const redis = createClient({
    socket: {
        host: process.env.REDIS_HOST || "10.100.112.114",
        port: parseInt(process.env.REDIS_PORT || "6379", 10),
    },
});

redis.on("connect", () => console.log(`🔗 Conectado a Redis ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`));
redis.on("connect", () => log("info", `🔗 Conectando a Redis ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`));
redis.on("ready", () => log("info", "✅ Redis listo y operativo"));
redis.on("reconnecting", () => log("warn", "♻️ Reintentando conexión Redis..."));
redis.on("error", (err) => log("error", "❌ Redis error", err.message));


redis.on("error", (err) => console.error("❌ Redis error:", err));

await redis.connect();

export default redis;
