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

        // 🔄 MAPEO LEGACY -> STRICT CONTRACT
        // Detectar si ttsText es en realidad un archivo de audio (Legacy pattern: "sound:path")
        if (result.ttsText && result.ttsText.startsWith('sound:')) {
            let soundPath = result.ttsText.replace('sound:', '').trim();
            // Remove 'voicebot/' prefix if present, as legacy-helpers adds it back
            if (soundPath.startsWith('voicebot/')) {
                soundPath = soundPath.replace('voicebot/', '');
            }

            result.audio = soundPath;
            result.action = 'PLAY_AUDIO'; // Override action to strict audio playback
            result.ttsText = null;        // Clear TTS to prevent engine confusion
            log("info", `🔄 [ADAPTER] Mapped legacy 'sound:' to action='PLAY_AUDIO'`, { audio: soundPath });
        } else if (result.ttsText && !result.action) {
            result.action = 'SAY_TEXT';
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
                action: { type: 'SET_STATE' },
                state: ctx.state // Preserve state
            });
        }

        log("debug", "🌉 [CAPSULE] Exiting Quintero Adapter", {
            phase: normalized.nextPhase,
            tts: normalized.ttsText ? 'YES' : 'NO',
            action: normalized.action
        });

        // Ensure state is returned for engine persistence
        return {
            ...normalized,
            state: result.state || ctx.state
        };

    } catch (error) {
        log("error", "🌉 💥 [CAPSULE] Error inside Quintero Adapter", error);
        throw error; // Engine handles global errors
    }
}
