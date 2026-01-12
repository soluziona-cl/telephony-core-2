import { log } from '../../../../lib/logger.js';
import quinteroBot from '../bot/index.js';

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
        const result = await quinteroBot(ctx);

        // ✅ VALIDACIÓN DEFENSIVA
        if (result.prompt) {
            result.prompt = safePrompt(result.prompt);
        }

        log("debug", "🌉 [CAPSULE] Exiting Quintero Adapter", {
            phase: result.state?.rutPhase,
            next: result.nextPhase
        });

        return result;
    } catch (error) {
        log("error", "🌉 💥 [CAPSULE] Error inside Quintero Adapter", error);
        throw error; // Let the engine handle global errors, or map to a safe fallback here
    }
}


