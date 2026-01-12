import fs from "fs";
import { promisify } from "util";
import { exec } from "child_process";

const execAsync = promisify(exec);
const VOICEBOT_PATH = "/opt/telephony-core/services/voice_static";
const OUTPUT_PATH = "/var/lib/asterisk/sounds/voicebot";

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

async function generateCombinedGreeting() {
    loadEnv();

    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY no encontrada en .env");
    }

    const combinedText = "Hola, soy Sofía, bienvenido al Consultorio Médico de Quintero. Para poder ayudarlo con su cita médica, primero necesito su RUT. Por favor, indíqueme los números de su RUT, sin el dígito verificador.";

    console.log(`🎙️ Generando audio combinado con TTS API...`);
    console.log(`📝 Texto: "${combinedText}"`);

    const tmpMp3 = `/tmp/greeting_sofia_2.mp3`;
    const finalWav = `${OUTPUT_PATH}/greeting_sofia_2.wav`;

    // Usar curl para llamar a la API de TTS de OpenAI directamente
    const curlCmd = `curl https://api.openai.com/v1/audio/speech \\
      -H "Authorization: Bearer ${process.env.OPENAI_API_KEY}" \\
      -H "Content-Type: application/json" \\
      -d '{
        "model": "tts-1",
        "input": ${JSON.stringify(combinedText)},
        "voice": "nova",
        "response_format": "mp3"
      }' \\
      --output "${tmpMp3}"`;

    await execAsync(curlCmd);
    console.log(`✅ MP3 generado: ${tmpMp3}`);

    // Convertir MP3 a WAV 8kHz para Asterisk
    const ffmpegCmd = `ffmpeg -y -i "${tmpMp3}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWav}"`;
    await execAsync(ffmpegCmd);
    console.log(`✅ WAV generado: ${finalWav}`);

    // Limpiar temporal
    fs.unlinkSync(tmpMp3);

    console.log(`🎉 Listo! Archivo: ${finalWav}`);
    process.exit(0);
}

generateCombinedGreeting().catch(err => {
    console.error("❌ Error:", err.message);
    process.exit(1);
});
