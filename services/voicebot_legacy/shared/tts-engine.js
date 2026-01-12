import { inboundConfig as config } from "../inbound/voicebot-config-inbound.js";
import { elevenlabsTTS } from "./tts-elevenlabs.js";
import { log } from "../../../lib/logger.js";

/**
 * Produce un archivo WAV 8k listo para playback
 * Retorna: baseName sin extensión
 */
export async function universalTTS(text, openaiClient = null) {
    const provider = config.tts.provider || "openai";

    log("info", `🔉 [TTS Engine] Usando proveedor: ${provider}`);

    if (provider === "elevenlabs") {
        return await elevenlabsTTS(text);
    }

    if (provider === "openai") {
        if (!openaiClient) {
            log("error", "❌ OpenAI requerido pero no enviado");
            return null;
        }

        const rspPcm = await openaiClient.sendTextAndWait(text);
        if (!rspPcm) return null;

        // === Reutilizamos la misma lógica que processUserTurnWithOpenAI ===
        const rspId = `vb_rsp_${Date.now()}`;
        const raw = `/tmp/${rspId}.pcm`;
        const final = `${config.paths.voicebot}/${rspId}.wav`;

        fs.writeFileSync(raw, rspPcm);

        const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${raw}" -ar 8000 -ac 1 -c:a pcm_s16le "${final}"`;
        const { execSync } = await import("child_process");
        execSync(cmd);

        return rspId;
    }

    log("error", "❌ Proveedor TTS no válido");
    return null;
}
