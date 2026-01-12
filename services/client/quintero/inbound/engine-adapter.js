import { normalizeDomainResponse, assertDomainResponse } from '../domainResponse.js';
import quinteroBot from '../bot/index.js';
import { log } from '../../../../lib/logger.js';

/**
 * 🌉 Quintero Capsule Adapter
 * The ONLY allowed entry point for the legacy engine to access Quintero logic.
 * Enforces isolation boundaries.
 */
// ✅ GUARDRAIL: Validar estrictamente string prompt
function safePrompt(prompt) {
    if (typeof prompt !== 'string') {
        throw new Error(`[DOMAIN ERROR] prompt debe ser string. Recibido: ${typeof prompt} (${JSON.stringify(prompt)})`);
    }
    return prompt;
}

export default async function quinteroAdapter(ctx) {
    log("info", "🌉 [CAPSULE] Entering Quintero Adapter");

    try {
        // Delegate to internal bot logic
        let result = await quinteroBot(ctx);

        // ✅ VALIDACIÓN DEFENSIVA (Legacy prompt check)
        if (result.prompt) {
            result.prompt = safePrompt(result.prompt);
        }

        // ✅ GOBERNANZA: Normalizar y Validar Contrato
        // Mapeamos legacy properties si es necesario antes de normalizar
        if (result.shouldHangup && !result.action) {
            result.action = { type: 'END_CALL', payload: { reason: 'LEGACY_SHOULD_HANGUP' } };
        }

        const normalized = normalizeDomainResponse(result, ctx.state?.rutPhase);
        const errs = assertDomainResponse(normalized);

        if (errs.length > 0) {
            log("warn", `⚠️ [CAPSULE][CONTRACT] Invalid response from bot: ${JSON.stringify(errs)}`, { result });
            // Fail-Closed Fallback: Ask user to repeat or hold, do not crash.
            return normalizeDomainResponse({
                nextPhase: ctx.state?.rutPhase || 'WAIT_BODY',
                ttsText: 'Disculpe, hubo un error técnico. ¿Podría repetir?',
                silent: false,
                skipUserInput: false,
                action: { type: 'SET_STATE' }
            });
        }

        log("debug", "🌉 [CAPSULE] Exiting Quintero Adapter", {
            phase: normalized.nextPhase,
            tts: normalized.ttsText ? 'YES' : 'NO'
        });

        return normalized;

    } catch (error) {
        log("error", "🌉 💥 [CAPSULE] Error inside Quintero Adapter", error);
        throw error; // Engine handles global errors
    }
}
