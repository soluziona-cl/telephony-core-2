// =========================================================
// VOICEBOT HANDLER - Evoluziona Telephony Core (INBOUND)
// =========================================================

import { startVoiceBotSessionV3 } from "./voicebot-engine-inbound-v3.js";
import startVoiceBotSessionWithQuery from "./voicebot-engine-inbound-withQuery-v0.js";
import { log } from "../../../lib/logger.js";
import { inboundConfig } from "./voicebot-config-inbound.js";

// Feature flag para habilitar routing por dominios
const USE_DOMAIN_ROUTING = process.env.USE_DOMAIN_ROUTING === 'true' || false;

// =========================================================
// Handler principal (Stasis)
// Dialplan: Stasis(crm_app, voicebot, ANI, DNIS)
// args[0] = "voicebot"
// args[1] = ANI
// args[2] = DNIS
// =========================================================

export async function handleVoiceBot(ari, channel, args, linkedId) {
    const mode = args[0] || "voicebot";
    const ani = args[1];
    const dnis = args[2];

    if (!ani || !dnis) {
        log("error", "❌ [VB HANDLER] ANI o DNIS no recibido correctamente");
        return;
    }

    // Lookup bot config
    const botConfig = inboundConfig.bots[mode];

    if (!botConfig) {
        log("error", `❌ [VB HANDLER] Modo desconocido o no soportado: "${mode}"`);
        return;
    }

    const promptFile = botConfig.prompt;

    // Activar routing por dominio para bots específicos
    let DomainRouting = USE_DOMAIN_ROUTING;
    if (mode === 'voicebot_quintero_query' || mode === 'voicebot_identity_quintero' || mode === 'voicebot_quintero') {
        DomainRouting = true;
        log("info", `🔀 [VB HANDLER] DomainRouting activado específicamente para mode=${mode}`);
    }

    log("info", `🤖 [VB HANDLER] Mode=${mode} ANI=${ani} DNIS=${dnis} Prompt=${promptFile} DomainRouting=${DomainRouting}`);

    try {
        // Si el routing por dominios está habilitado y el modo es compatible, usar dominio
        if (DomainRouting && mode.startsWith('voicebot_')) {
            // Importar router dinámicamente solo cuando se necesita
            const { resolveDomain, extractBotName } = await import("../router/voicebot-domain-router.js");
            const domain = await resolveDomain(mode);
            // 🛡️ FIX: Forzar botName para capsulas conocidas si extractBotName falla o es ambiguo
            let botName = extractBotName(mode);
            if (mode.includes('quintero')) {
                botName = 'quintero';
            }

            if (domain) {
                log("info", `🔀 [VB HANDLER] Usando dominio para mode=${mode}, bot=${botName}`);
                // El dominio se pasará al engine para que lo use cuando corresponda
                // Por ahora, el engine seguirá funcionando igual, pero con el dominio disponible
                await startVoiceBotSessionV3(ari, channel, ani, dnis, linkedId, promptFile, {
                    domain,
                    botName,
                    mode
                });
                return;
            }
        }

        // Modo tradicional (sin dominios)
        await startVoiceBotSessionV3(ari, channel, ani, dnis, linkedId, promptFile);
    } catch (err) {
        log("error", `❌ [VB HANDLER] Error en VoiceBot: ${err.message}`);
    }
}

export default handleVoiceBot;
