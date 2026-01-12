import WebSocket from "ws";
import fs from "fs";
import { log } from "../../lib/logger.js";
import { convertWavToUlaw } from "./audio-utils.js";

export async function askRealtimeAndGetReply(wavPath) {
    return new Promise((resolve) => {

        const ws = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime", {
            headers: {
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        ws.on("open", () => {
            log("info", "🌐 [VB] Realtime conectado");

            // Configuración inicial de sesión
            ws.send(JSON.stringify({
                type: "session.update",
                session: {
                    instructions: "Eres un asistente de voz corto y claro. Responde como IVR.",
                    input_audio_transcription: "whisper-1",
                    output_audio_format: "wav",
                    turn_detection: { type: "server_vad" }
                }
            }));

            // Enviar audio grabado
            const wavBuffer = fs.readFileSync(wavPath);
            ws.send(wavBuffer);
        });

        ws.on("message", async (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.type === "response.audio.delta") {

                    const wavBase64 = msg.delta;
                    const wavBuffer = Buffer.from(wavBase64, "base64");

                    // Convertir a ULaw
                    const ulawPath = await convertWavToUlaw(wavBuffer);

                    // Cerrar WS porque solo queremos 1 respuesta
                    ws.close();

                    return resolve(ulawPath.replace("/tmp/", ""));
                }
            } catch {
                // Puede ser audio binario, ignorar
            }
        });

        ws.on("close", () => resolve(null));
        ws.on("error", (e) => {
            log("error", "Realtime error: " + e.message);
            resolve(null);
        });
    });
}
