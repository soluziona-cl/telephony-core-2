#!/usr/bin/env node
import fs from "fs";
import https from "https";
import { promisify } from "util";
import { exec } from "child_process";

const execAsync = promisify(exec);

const VOICEBOT_PATH = "/var/lib/asterisk/sounds/voicebot/corralele_03";
const SAMPLE_RATE_INPUT = 22050; // ElevenLabs default
const SAMPLE_RATE_ASTERISK = 8000;

const MESSAGES = {
    saludo_inicial: "Hola, usted se ha comunicado con el Hospital Comunitario y Familiar de Corral.",
    opcion_1: "Si desea comunicarse con agenda, presione uno.",
    opcion_2: "Hospitalizados, presione dos.",
    opcion_3: "Laboratorio, presione tres.",
    opcion_4: "Farmacia, presione cuatro.",
    opcion_5: "Oficina de informaciones y otras consultas, presione cinco.",
    despedida: "Por su seguridad esta llamada será grabada.",
    horario_atencion: "Nuestro horario de atención es de lunes a jueves de ocho a diecisiete horas, y viernes de ocho a dieciséis horas.",
    ocupado: "Nuestros agentes se encuentran ocupados. Por favor, permanezca en línea."
};

// ===================== ENV LOADER =====================
function loadEnv() {
    const envPath = "/opt/telephony-core/.env";
    if (!fs.existsSync(envPath)) return;

    const content = fs.readFileSync(envPath, "utf8");
    content.split("\n").forEach(line => {
        const match = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?$/);
        if (!match) return;
        let value = match[2] || "";
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        process.env[match[1]] = value;
    });
}

// ===================== ELEVENLABS TTS =====================
async function elevenTTS(text) {
    return new Promise((resolve, reject) => {
        const voiceId = process.env.ELEVENLABS_VOICE_ID;
        const apiKey = process.env.ELEVENLABS_API_KEY;

        const postData = JSON.stringify({
            text,
            model_id: "eleven_multilingual_v2",
            voice_settings: {
                stability: 0.55,
                similarity_boost: 0.75,
                style: 0.15,
                use_speaker_boost: true
            }
        });

        const options = {
            hostname: "api.elevenlabs.io",
            port: 443,
            path: `/v1/text-to-speech/${voiceId}`,
            method: "POST",
            headers: {
                "xi-api-key": apiKey,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
                "Accept": "audio/wav"
            },
            timeout: 15000
        };

        const req = https.request(options, res => {
            const chunks = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () => {
                const body = Buffer.concat(chunks);
                if (res.statusCode !== 200) {
                    const errorBody = body.toString();
                    reject(new Error(`ElevenLabs API ${res.statusCode}: ${errorBody}`));
                    return;
                }
                resolve(body);
            });
        });

        req.on("error", reject);
        req.write(postData);
        req.end();
    });
}

// ===================== MAIN =====================
async function generateAllAudios() {
    loadEnv();

    if (!process.env.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY missing");
    if (!process.env.ELEVENLABS_VOICE_ID) throw new Error("ELEVENLABS_VOICE_ID missing");

    if (!fs.existsSync(VOICEBOT_PATH)) fs.mkdirSync(VOICEBOT_PATH, { recursive: true });

    console.log(`🎙️ ElevenLabs IVR Generator`);
    console.log(`📂 Path: ${VOICEBOT_PATH}`);
    console.log(`🧠 Voice: ${process.env.ELEVENLABS_VOICE_ID}`);
    console.log(`🧾 Total messages: ${Object.keys(MESSAGES).length}\n`);

    for (const [name, text] of Object.entries(MESSAGES)) {
        const wavFile = `${VOICEBOT_PATH}/${name}.wav`;
        const tmpFile = `/tmp/${name}_${Date.now()}.wav`;

        try {
            console.log(`⏳ Generando ${name}`);
            const buffer = await elevenTTS(text);
            fs.writeFileSync(tmpFile, buffer);

            // Convertir a formato Asterisk telephony-grade
            const cmd = `
        ffmpeg -y -i "${tmpFile}" \
        -ar ${SAMPLE_RATE_ASTERISK} -ac 1 -c:a pcm_s16le \
        "${wavFile}"
      `;
            await execAsync(cmd);
            fs.unlinkSync(tmpFile);

            const size = fs.statSync(wavFile).size;
            console.log(`   ✅ OK (${size} bytes)`);
        } catch (err) {
            console.error(`   ❌ ERROR ${name}:`, err.message);
        }
    }

    console.log("\n🎉 Todos los audios generados para Asterisk.");
}

generateAllAudios().catch(e => {
    console.error("FATAL:", e);
    process.exit(1);
});
