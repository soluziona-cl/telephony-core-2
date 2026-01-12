#!/usr/bin/env node

/**
 * 🚀 Telephony Core - Main Entry Point
 * Servicio principal que integra Asterisk ARI con todos los módulos
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import ari from "ari-client";
import { log } from "./lib/logger.js";
import { connectRedis } from "./lib/redis.js";
import { connectMSSQL } from "./lib/database.js";

// Handlers
import { voicebotHandler } from "./services/voicebot/voicebot-handler.js";
// Importa aquí otros handlers según los necesites
// import { agentTrackerHandler } from "./services/agent-tracker.js";
// import { businessRulesHandler } from "./services/business-rules.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cargar variables de entorno
dotenv.config({ path: join(__dirname, ".env") });

// Configuración
const CONFIG = {
    ari: {
        url: process.env.ARI_URL || "http://localhost:8088",
        username: process.env.ARI_USERNAME || "asterisk",
        password: process.env.ARI_PASSWORD || "asterisk",
        appName: process.env.ARI_APP_NAME || "crm_app"
    },
    redis: {
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379"),
        password: process.env.REDIS_PASSWORD || ""
    },
    mssql: {
        server: process.env.MSSQL_SERVER,
        user: process.env.MSSQL_USER,
        password: process.env.MSSQL_PASSWORD,
        database: process.env.MSSQL_DATABASE
    }
};

// Variables globales
let ariClient = null;
let redisClient = null;
let sqlPool = null;

/**
 * 🔌 Inicializa todas las conexiones
 */
async function initialize() {
    log("info", "🚀 Iniciando Telephony Core...");

    try {
        // 1. Conectar Redis
        log("info", `🔴 Conectando a Redis ${CONFIG.redis.host}:${CONFIG.redis.port}`);
        redisClient = await connectRedis(CONFIG.redis);
        log("info", "✅ Redis conectado");

        // 2. Conectar MSSQL
        if (CONFIG.mssql.server) {
            log("info", `💾 Conectando a MSSQL ${CONFIG.mssql.server}`);
            sqlPool = await connectMSSQL(CONFIG.mssql);
            log("info", "✅ MSSQL conectado");
        }

        // 3. Conectar ARI
        log("info", `⭐ Conectando a Asterisk ARI ${CONFIG.ari.url}`);
        ariClient = await ari.connect(
            CONFIG.ari.url,
            CONFIG.ari.username,
            CONFIG.ari.password
        );
        log("info", "✅ ARI conectado");

        // 4. Iniciar aplicación Stasis
        ariClient.start(CONFIG.ari.appName);
        log("info", `📱 Aplicación Stasis iniciada: ${CONFIG.ari.appName}`);

        // 5. Registrar manejadores de eventos
        setupEventHandlers(ariClient);

        log("info", "🎉 Telephony Core iniciado correctamente");

    } catch (error) {
        log("error", `❌ Error durante inicialización: ${error.message}`);
        log("error", error.stack);
        process.exit(1);
    }
}

/**
 * 📡 Configura manejadores de eventos ARI
 */
function setupEventHandlers(client) {

    // Evento principal: StasisStart (llamada entra a la app)
    client.on("StasisStart", async (event, channel) => {
        const ani = channel.caller.number || "Unknown";
        const args = event.args || [];
        const handler = args[0]; // Primer argumento define el handler

        log("info", `📞 StasisStart: ANI=${ani}, Handler=${handler}, Args=${args.join(",")}`);

        try {
            // Router de handlers según primer argumento
            switch (handler) {
                case "voicebot":
                    await voicebotHandler(client, event, channel, args);
                    break;

                // case "agent-tracker":
                //     await agentTrackerHandler(client, event, channel, args);
                //     break;

                // case "business-rules":
                //     await businessRulesHandler(client, event, channel, args);
                //     break;

                default:
                    log("warn", `⚠️ Handler desconocido: ${handler}`);
                    await channel.answer();
                    await channel.play({ media: "sound:tt-monkeys" });
                    await channel.hangup();
            }

        } catch (error) {
            log("error", `❌ Error en handler '${handler}': ${error.message}`);
            log("error", error.stack);

            try {
                await channel.hangup();
            } catch (e) {
                // Canal ya colgado
            }
        }
    });

    // Evento: Canal colgado
    client.on("StasisEnd", (event, channel) => {
        const ani = channel.caller?.number || "Unknown";
        log("info", `🔚 StasisEnd: ANI=${ani}, Channel=${channel.id}`);
    });

    // Evento: Error en WebSocket
    client.on("WebSocketConnected", () => {
        log("info", "✅ WebSocket ARI conectado");
    });

    client.on("WebSocketReconnecting", () => {
        log("warn", "⚠️ Reconectando WebSocket ARI...");
    });

    // Healthcheck periódico
    setInterval(() => {
        log("debug", "🏥 Healthcheck OK");
    }, 60000); // Cada minuto
}

/**
 * 🛑 Manejo de señales de cierre
 */
function setupShutdownHandlers() {
    const shutdown = async (signal) => {
        log("info", `🛑 Recibida señal ${signal}, cerrando aplicación...`);

        try {
            // Cerrar conexiones
            if (ariClient) {
                log("info", "🔌 Cerrando ARI...");
                // ariClient no tiene método close directo
            }

            if (redisClient) {
                log("info", "🔌 Cerrando Redis...");
                await redisClient.quit();
            }

            if (sqlPool) {
                log("info", "🔌 Cerrando MSSQL...");
                await sqlPool.close();
            }

            log("info", "✅ Aplicación cerrada correctamente");
            process.exit(0);

        } catch (error) {
            log("error", `❌ Error durante cierre: ${error.message}`);
            process.exit(1);
        }
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    process.on("uncaughtException", (error) => {
        log("error", `❌ Excepción no capturada: ${error.message}`);
        log("error", error.stack);
    });

    process.on("unhandledRejection", (reason, promise) => {
        log("error", `❌ Promesa rechazada no manejada: ${reason}`);
    });
}

/**
 * 🚀 Punto de entrada
 */
async function main() {
    console.log(`
╔═══════════════════════════════════════════╗
║                                           ║
║      📞 TELEPHONY CORE SERVICE 🚀         ║
║                                           ║
║    Asterisk ARI + OpenAI Integration     ║
║                                           ║
╚═══════════════════════════════════════════╝
    `);

    setupShutdownHandlers();
    await initialize();
}

// Ejecutar
main().catch((error) => {
    console.error("❌ Error fatal:", error);
    process.exit(1);
});