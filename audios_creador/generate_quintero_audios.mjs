#!/usr/bin/env node
import fs from "fs";
import { promisify } from "util";
import { exec } from "child_process";
import https from "https";

const execAsync = promisify(exec);

const VOICEBOT_PATH = "/var/lib/asterisk/sounds/voicebot/quintero";
const VOICE_ID = "marin"; // Voz configurada para Quintero

// Mensajes a generar
// const MESSAGES = {
//     "greeting_sofia_2": "Hola, soy Sofia, bienvenido al Consultorio Médico de Quintero. Para poder ayudarlo con su cita médica, primero necesito que me indique su RUT",
//     "ask_rut": "Por favor, indíqueme su RUT completo, incluyendo el dígito verificador.",
//     "ask_rut_retry": "Por favor, indíqueme su RUT completo, incluyendo el dígito verificador. Por ejemplo: catorce millones, trescientos cuarenta mil, guión ocho.",
//     "ask_specialty": "¿Para qué especialidad médica necesita agendar su hora? Por ejemplo, medicina general, control o alguna especialidad en particular.",
//     "ask_specialty_retry": "¿Podría indicarme la especialidad médica que necesita? Por ejemplo, medicina general o control.",
//     "ask_specialty_examples": "Por favor, dígame la especialidad. Puede ser: medicina general, pediatría, control, o cualquier otra.",
//     "offer_alternatives": "No hay horas disponibles para la especialidad indicada. ¿Desea buscar otra especialidad, consultar otra fecha, o hablar con una ejecutiva?",
//     "transfer_agent": "No he podido escucharle correctamente. Le transferiré con una ejecutiva para continuar su atención. Un momento por favor.",
//     "farewell": "Muchas gracias, hasta luego."
// };

const MESSAGES = {
    "greeting_sofia_2": "Hola soy Sofia, bienvenido al Consultorio Médico de Quintero. Para poder ayudarlo con su cita médica, primero necesito que me indique su RUT",
    "ask_rut": "Por favor, indíqueme su RUT completo, incluyendo el dígito verificador.",
    "ask_rut_retry": "Por favor, indíqueme su RUT completo, incluyendo el dígito verificador. Por ejemplo: catorce millones, trescientos cuarenta mil, guión ocho.",
    "ask_specialty_retry": "¿Podría indicarme la especialidad médica que necesita? Por ejemplo, medicina general o control.",
    "ask_specialty_examples": "Por favor, dígame la especialidad. Puede ser: medicina general, pediatría, control, o cualquier otra.",
    "offer_alternatives": "No hay horas disponibles para la especialidad indicada. ¿Desea buscar otra especialidad, consultar otra fecha, o hablar con una ejecutiva?",
    "transfer_agent": "No he podido escucharle correctamente. Le transferiré con una ejecutiva para continuar su atención. Un momento por favor.",
    "farewell": "Muchas gracias, hasta luego.",
    "ask_specialty": "¿Qué especialidad médica necesita? Por ejemplo: medicina general, pediatría o control."
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

async function generateStaticTTS(text, outputFile) {
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

async function generateAllAudios() {
    loadEnv();

    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY no encontrada en .env");
    }

    // Crear directorio si no existe
    if (!fs.existsSync(VOICEBOT_PATH)) {
        fs.mkdirSync(VOICEBOT_PATH, { recursive: true });
        console.log(`📁 Directorio creado: ${VOICEBOT_PATH}`);
    }

    console.log(`🎙️ Generando ${Object.keys(MESSAGES).length} audios estáticos para Quintero...`);
    console.log(`🗣️ Voz: ${VOICE_ID}\n`);

    for (const [filename, text] of Object.entries(MESSAGES)) {
        const wavFile = `${VOICEBOT_PATH}/${filename}.wav`;

        console.log(`⏳ Generando: ${filename}.wav`);
        console.log(`   Texto: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);

        try {
            // 1. Obtener PCM de OpenAI
            const pcmBuffer = await generateStaticTTS(text, wavFile);

            const tempPcm = `/tmp/${filename}_temp_${Date.now()}.pcm`;
            fs.writeFileSync(tempPcm, pcmBuffer);

            // 2. Convertir a WAV 8000Hz Mono (Formato Asterisk)
            const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${tempPcm}" -ar 8000 -ac 1 -c:a pcm_s16le "${wavFile}"`;
            await execAsync(cmd);

            fs.unlinkSync(tempPcm);

            const size = fs.statSync(wavFile).size;
            console.log(`   ✅ Generado: ${size} bytes\n`);
        } catch (err) {
            console.error(`   ❌ Error: ${err.message}\n`);
        }
    }

    console.log(`\n🎉 Proceso completado. Audios guardados en: ${VOICEBOT_PATH}`);
}

generateAllAudios().catch(err => {
    console.error("❌ Error fatal:", err);
    process.exit(1);
});
