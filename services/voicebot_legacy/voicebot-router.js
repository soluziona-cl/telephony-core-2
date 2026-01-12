import WebSocket from "ws";
import { toPcm, fromPcm } from "./voicebot-audio.js";

export function startVoiceBotSession(ari, channel) {

    // WS hacia N8N
    const ws = new WebSocket("wss://tu-n8n/voicebot");

    ws.on("open", () => {
        console.log("WS conectado con n8n");
    });

    // Recibe audio del BOT → lo inyectamos a Asterisk
    ws.on("message", async (pcm) => {
        const encoded = fromPcm(pcm);
        await channel.play({ media: `sound:${encoded}` });
    });

    // Captura DTMF
    channel.on("ChannelDtmfReceived", (e) => {
        ws.send(JSON.stringify({ dtmf: e.digit }));
    });

    // On Hangup
    channel.on("StasisEnd", () => ws.close());
}
