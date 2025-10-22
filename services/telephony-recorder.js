// /services/telephony-recorder.js
import { log } from "../lib/logger.js";

export function getRecordingPath({ tenantId, linkedId, ani, dnis }) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");

    return `/recordings/${tenantId}/${yyyy}/${mm}/${dd}/${linkedId}_${ani}_${dnis}.wav`;
}

/**
 * Simulación: inicia la grabación al contestar
 */
export async function startRecording(channel, linkedId, ani, dnis) {
    try {
        const path = getRecordingPath({ tenantId: 1, linkedId, ani, dnis });
        log("info", `🎙️ Iniciando grabación → ${path}`);
        // TODO: Llamar ARI recordings.start si se requiere
        return path;
    } catch (err) {
        log("error", "Error al iniciar grabación", err.message);
        return null;
    }
}
