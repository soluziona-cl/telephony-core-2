// /services/telephony-controller.js
import AriClient from "ari-client";
import dotenv from "dotenv";
import { log } from "../lib/logger.js";

dotenv.config();

let ari = null;
const ARI_URL = process.env.ARI_URL || "http://127.0.0.1:8088";
const ARI_USER = process.env.ARI_USER || "crm_ari";
const ARI_PASS = process.env.ARI_PASS || "1234";
const ARI_APP = process.env.ARI_APP || "crm-core";

/** Inicializa conexión ARI si no existe */
export async function initAri() {
    if (ari) return ari;
    ari = await AriClient.connect(ARI_URL, ARI_USER, ARI_PASS);
    log("info", "✅ Conectado a Asterisk ARI desde telephony-controller");
    return ari;
}

/** Origina una llamada saliente */
export async function makeCall(ani, dnis, variables = {}) {
    const client = await initAri();
    try {
        const res = await client.channels.originate({
            endpoint: `PJSIP/${dnis}`,
            extension: dnis,
            callerId: ani,
            app: ARI_APP,
            appArgs: `outbound,${ani},${dnis}`,
            variables,
        });
        log("info", `📞 Llamada originada: ${ani} → ${dnis}`);
        return res;
    } catch (err) {
        log("error", "Error al originar llamada", err.message);
    }
}

/** Finaliza una llamada activa */
export async function hangup(channelId) {
    const client = await initAri();
    try {
        await client.channels.hangup({ channelId });
        log("info", `☎️ Llamada colgada → ${channelId}`);
    } catch (err) {
        log("error", "Error al colgar llamada", err.message);
    }
}

/** Transferencia ciega */
export async function blindTransfer(channelId, target) {
    const client = await initAri();
    try {
        await client.channels.redirect({ channelId, endpoint: `PJSIP/${target}` });
        log("info", `🔀 Transferencia ciega ${channelId} → ${target}`);
    } catch (err) {
        log("error", "Error en transferencia", err.message);
    }
}
