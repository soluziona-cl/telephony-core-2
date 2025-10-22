import WebSocket from "ws";
import axios from "axios";

// Configuración general
const ARI_BASE = "http://127.0.0.1:8088/ari";
const WS_URL = "ws://127.0.0.1:8088/ari/events?api_key=crm_ari:1234&app=crm_app";
const AUTH = { username: "crm_ari", password: "1234" };

// ======================================================
// 🛰️ 1. Conexión WebSocket ARI
// ======================================================
function startAriWebSocket() {
    const ws = new WebSocket(WS_URL);

    ws.on("open", () => console.log("✅ Conectado a Asterisk ARI (WebSocket)"));
    ws.on("close", () => console.log("⚠️ Conexión ARI cerrada, reintentando en 3s...") || setTimeout(startAriWebSocket, 3000));
    ws.on("error", err => console.error("❌ Error en WebSocket:", err.message));

    ws.on("message", raw => {
        try {
            const event = JSON.parse(raw.toString());
            console.log("📡 Evento ARI:", event.type);

            // --- Ejemplos de manejo ---
            switch (event.type) {
                case "StasisStart":
                    console.log(`➡️ Llamada entrante desde ${event.channel.caller.number}`);
                    break;

                case "ChannelStateChange":
                    console.log(`🔄 Canal ${event.channel.name} → ${event.channel.state}`);
                    break;

                case "StasisEnd":
                    console.log(`📴 Fin de llamada ${event.channel.id}`);
                    break;

                case "ChannelDestroyed":
                    console.log(`💥 Canal destruido: ${event.channel.id}`);
                    break;

                default:
                    break;
            }
        } catch (err) {
            console.error("Error al parsear evento ARI:", err);
        }
    });
}

// ======================================================
// 📞 2. Funciones auxiliares (REST API)
// ======================================================

// Crear una llamada saliente
async function originateCall(endpoint, callerId) {
    try {
        const res = await axios.post(
            `${ARI_BASE}/channels`,
            {
                endpoint,
                app: "crm_app",
                callerId,
                timeout: 30
            },
            { auth: AUTH }
        );
        console.log("📞 Llamada creada:", res.data.id);
    } catch (err) {
        console.error("Error al originar llamada:", err.response?.data || err.message);
    }
}

// Colgar llamada
async function hangupChannel(channelId) {
    try {
        await axios.delete(`${ARI_BASE}/channels/${channelId}`, { auth: AUTH });
        console.log("🛑 Canal colgado:", channelId);
    } catch (err) {
        console.error("Error al colgar canal:", err.message);
    }
}

// ======================================================
// 🚀 Inicio del servicio
// ======================================================
startAriWebSocket();

// Ejemplo: generar llamada después de 5 segundos
setTimeout(() => {
    originateCall("PJSIP/1001", "CRM-Test");
}, 5000);
