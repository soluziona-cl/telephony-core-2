import fs from "fs";
import { promisify } from "util";
import { exec } from "child_process";
import https from "https";
import { inboundConfig } from "../services/voicebot/inbound/voicebot-config-inbound.js";

const execAsync = promisify(exec);

// Recorrer configuración desde inboundConfig
const PROFILE_NAME = "voicebot_quintero";
const botConfig = inboundConfig.bots[PROFILE_NAME];

if (!botConfig) {
    console.error(`❌ Perfil '${PROFILE_NAME}' no encontrado en inboundConfig.`);
    process.exit(1);
}

const VOICEBOT_PATH = inboundConfig.paths.voicebot;
// Usamos la voz definida en la base (común) o podríamos especificarla por bot si existiera override
let VOICE_ID = inboundConfig.openai?.voice || "nova";

// Mapping de compatibilidad deleted

function loadEnv() {
    const envPath = "/opt/telephony-core/.env";
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf8");
        content.split("\n").forEach(line => {
            const match = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?\s*$/);
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

async function generateStaticTTS(text, outputFile) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: "gpt-4o-mini-tts",
            voice: VOICE_ID,
            input: text,
            instructions: "Speak in a cheerful and positive tone.",
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

async function generateCombinedGreeting() {
    loadEnv();

    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY no encontrada en .env");
    }

    // Ensure directory exists
    if (!fs.existsSync(VOICEBOT_PATH)) {
        fs.mkdirSync(VOICEBOT_PATH, { recursive: true });
    }

    // Nombre de archivo definido en la config del bot (o default)
    const filename = botConfig.greetingFile || "greeting_sofia";
    const wavFile = `${VOICEBOT_PATH}/${filename}.wav`;

    // Texto fijo solicitado
    const combinedText = "Hola, soy Sofia, bienvenido al Consultorio Médico de Quintero. Para poder ayudarlo con su cita médica, primero necesito que me indique su RUT";

    console.log(`🎙️ Generando audio estático (TTS Directo)...`);
    console.log(`⚙️  Perfil: ${PROFILE_NAME}`);
    console.log(`🗣️  Voz: ${VOICE_ID}`);
    console.log(`� Ruta: ${wavFile}`);
    console.log(`�📝 Texto: "${combinedText}"`);

    // 1. Obtener PCM de OpenAI
    const pcmBuffer = await generateStaticTTS(combinedText, wavFile);

    const tempPcm = `/tmp/${filename}_temp_${Date.now()}.pcm`;
    fs.writeFileSync(tempPcm, pcmBuffer);

    // 2. Convertir a WAV 8000Hz Mono (Formato Asterisk)
    const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${tempPcm}" -ar 8000 -ac 1 -c:a pcm_s16le "${wavFile}"`;

    await execAsync(cmd);

    fs.unlinkSync(tempPcm);

    console.log(`✅ Audio generado exitosamente: ${wavFile}`);
    console.log(`📊 Tamaño: ${fs.statSync(wavFile).size} bytes`);
}

generateCombinedGreeting().catch(err => {
    console.error("❌ Error fatal:", err);
    process.exit(1);
});
