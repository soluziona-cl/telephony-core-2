// =========================================================
// VOICEBOT HANDLER - Evoluziona Telephony Core
// =========================================================

import { startVoiceBotSessionV3 } from "./voicebot-engine-v3.js";
import { log } from "../../lib/logger.js";

// =========================================================
// Handler principal
// =========================================================

export async function handleVoiceBot( ari, channel, args, linkedId ) {
  
    // El dialplan envía:
    // Stasis(crm_app, voicebot, ANI, DNIS)
    const ani = args[1];  // ❌ ANTES: args[2] 
    const dnis = args[2]; // ❌ ANTES: args[3]


    if (!ani || !dnis) {
        log("error", "❌ [VB HANDLER] ANI o DNIS no recibido correctamente");
        return;
    }

    log("info", `🤖 [VB HANDLER] ANI=${ani} DNIS=${dnis} LinkedId=${linkedId}`);

    try {
        await startVoiceBotSessionV3(
            ari,
            channel,
            ani,
            dnis,
            linkedId
        );
    } catch (err) {
        log("error", `❌ [VB HANDLER] Error en VoiceBot: ${err.message}`);
    }
}

export default handleVoiceBot;
