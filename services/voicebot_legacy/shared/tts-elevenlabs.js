import fs from "fs";
import path from "path";
import { ElevenLabsClient } from "elevenlabs";
import { inboundConfig as config } from "../inbound/voicebot-config-inbound.js";
import { log } from "../../../lib/logger.js";

const client = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY
});

/**
 * Retorna un WAV 8k listo para Asterisk
 */
export async function elevenlabsTTS(text) {
    try {
        const tmpName = `eleven_${Date.now()}.wav`;
        const tmpPathRaw = `/tmp/${tmpName}`;
        const finalName = `vb_rsp_${Date.now()}.wav`;
        const finalPath = `${config.paths.voicebot}/${finalName}`;

        // === 1) TTS ElevenLabs PCM16 24k ===
        const audioResponse = await client.textToSpeech.convert({
            text,
            voiceId: config.tts.elevenlabs.voiceId,
            modelId: config.tts.elevenlabs.model,
            outputFormat: "pcm_16000"
        });

        const pcmBuffer = Buffer.from(await audioResponse.arrayBuffer());
        fs.writeFileSync(tmpPathRaw, pcmBuffer);

        // === 2) Convertir PCM → WAV 8k (Asterisk) ===
        const { execSync } = await import("child_process");
        const cmd = `ffmpeg -y -f s16le -ar 16000 -ac 1 -i "${tmpPathRaw}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalPath}"`;
        execSync(cmd);

        log("info", `🎤 ElevenLabs generado: ${finalPath}`);
        return path.basename(finalPath).replace(".wav", "");

    } catch (err) {
        log("error", `❌ ElevenLabs TTS ERROR: ${err.message}`);
        return null;
    }
}
