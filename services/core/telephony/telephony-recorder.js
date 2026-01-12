// /services/telephony-recorder.js
import { log } from "../../../lib/logger.js";

export function buildRecordingPath({ tenantId, linkedId, ani, dnis }) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");

    return `/opt/telephony-core/recordings/${tenantId}/${yyyy}/${mm}/${dd}/${linkedId}_${ani}_${dnis}.wav`;
}

export async function startRecording(ari, channel, tenantId, linkedId, ani, dnis) {
    try {
        const name = `${linkedId}_${ani}_${dnis}`.replace(/[^0-9A-Za-z_+]/g, "_");
        const target = `channel:${channel.id}`;
        const path = buildRecordingPath({ tenantId, linkedId, ani, dnis });

        // Usar la función correcta de ari-client para grabar un canal
        await channel.record({
            name,
            format: "wav",
            ifExists: "overwrite"
        });

        log("info", `🎙️ Grabación iniciada → ${path}`);
        return { path, name };

    } catch (err) {
        log("error", "Error al iniciar grabación", err.message);
        return { path: null, name: null };
    }
}

export async function stopRecording(ari, recName) {
    try {
        const rec = ari.recordings();
        rec.name = recName;
        await rec.stop();
        log("info", `🎙️ Grabación detenida: ${recName}`);
    } catch (err) {
        log("warn", `No se pudo detener grabación ${recName}`, err.message);
    }
}
