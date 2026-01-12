import { log } from '../../../../lib/logger.js';
import upcomBot from '../bot/index.js';

/**
 * 🌉 Upcom Capsule Adapter
 */
// ✅ GUARDRAIL: Validar estrictamente string prompt
function safePrompt(prompt) {
    if (typeof prompt !== 'string') {
        throw new Error(`[DOMAIN ERROR] prompt debe ser string. Recibido: ${typeof prompt} (${JSON.stringify(prompt)})`);
    }
    return prompt;
}

export default async function upcomAdapter(ctx) {
    log("info", "🌉 [CAPSULE] Entering Upcom Adapter");
    try {
        const result = await upcomBot(ctx);
        // ✅ VALIDACIÓN DEFENSIVA
        if (result.prompt) {
            result.prompt = safePrompt(result.prompt);
        }
        return result;
    } catch (error) {
        log("error", "🌉 💥 [CAPSULE] Error inside Upcom Adapter", error);
        throw error;
    }
}
