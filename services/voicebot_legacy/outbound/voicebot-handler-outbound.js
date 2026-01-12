import { log } from "../../../lib/logger.js";
import { startVoiceBotSessionV3_Outbound } from "./voicebot-engine-outbound.js";

export default async function handleOutboundVoiceBot(ari, channel, args) {

    const ani = channel.caller.number;
    const dnis = args[1];     // destino discado
    const callId = args[2];   // id de OutboundCallQueue

    log("info", `📞 [OUTBOUND] Iniciando voicebot → ANI=${ani} → Destino=${dnis}`);

    try {
        await startVoiceBotSessionV3_Outbound(ari, channel, ani, dnis, callId);
    } catch (err) {
        log("error", `❌ [OUTBOUND] Error: ${err.message}`);
    }
}
