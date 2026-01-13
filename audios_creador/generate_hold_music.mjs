#!/usr/bin/env node
import fs from "fs";
import { promisify } from "util";
import { exec } from "child_process";
import https from "https";

const execAsync = promisify(exec);

const TMP_PATH = "/tmp/quintero_hold_music";
const VOICE_ID = "marin";

// Solo mensajes nuevos (hold music transitions)
const NEW_MESSAGES = {
    "checking_availability": "Estoy revisando la disponibilidad, un momento por favor.",
    "validating_patient": "Estoy validando sus datos, por favor espere.",
    "searching_hours": "Buscando horas disponibles, un momento."
};

function loadEnv() {
    const envPath = "/opt/telephony-core/.env";
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf8");
        content.split("\n").forEach(line => {
            const match = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?$/);
            if (match) {
                const key = match[1];
                let value = match[2] || "";
                if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
                if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
                process.env[key] = value;
            }
        });
    }
}

async function generateStaticTTS(text) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: "gpt-4o-mini-tts",
            voice: VOICE_ID,
            input: text,
            instructions: "Speak seamlessly and naturally in Chilean Spanish.",
            response_format: "pcm"
        });

        const options = {
            hostname: "api.openai.com",
            port: 443,
            path: "/v1/audio/speech",
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`API Error: ${res.statusCode} ${res.statusMessage}`));
                return;
            }

            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
        });

        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

async function generateNewAudios() {
    loadEnv();

    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY no encontrada en .env");
    }

    if (!fs.existsSync(TMP_PATH)) {
        fs.mkdirSync(TMP_PATH, { recursive: true });
    }

    console.log(`🎙️ Generando ${Object.keys(NEW_MESSAGES).length} nuevos audios...`);
    console.log(`🗣️ Voz: ${VOICE_ID}`);
    console.log(`📁 Salida: ${TMP_PATH}\n`);

    for (const [filename, text] of Object.entries(NEW_MESSAGES)) {
        const wavFile = `${TMP_PATH}/${filename}.wav`;

        console.log(`⏳ ${filename}.wav`);
        console.log(`   "${text}"`);

        try {
            const pcmBuffer = await generateStaticTTS(text);
            const tempPcm = `/tmp/${filename}_${Date.now()}.pcm`;
            fs.writeFileSync(tempPcm, pcmBuffer);

            const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${tempPcm}" -ar 8000 -ac 1 -c:a pcm_s16le "${wavFile}"`;
            await execAsync(cmd);

            fs.unlinkSync(tempPcm);

            const size = fs.statSync(wavFile).size;
            console.log(`   ✅ ${size} bytes\n`);
        } catch (err) {
            console.error(`   ❌ ${err.message}\n`);
        }
    }

    console.log(`\n✅ Archivos generados en: ${TMP_PATH}`);
    console.log(`\n📋 Para copiarlos, ejecuta:`);
    console.log(`   sudo cp ${TMP_PATH}/*.wav /var/lib/asterisk/sounds/voicebot/quintero/`);
    console.log(`   sudo chown asterisk:asterisk /var/lib/asterisk/sounds/voicebot/quintero/*.wav`);
    console.log(`   sudo chmod 644 /var/lib/asterisk/sounds/voicebot/quintero/*.wav`);
}

generateNewAudios().catch(err => {
    console.error("❌ Error:", err);
    process.exit(1);
});
