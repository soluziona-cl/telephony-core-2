import fs from 'fs';
import { normalizeDomainResponse, assertDomainResponse } from '../domainResponse.js';
import quinteroBot from '../bot/index.js';
import webhookClient from '../n8n/webhook-client.js';
import { log } from '../../../../lib/logger.js';
import { domainTrace } from '../bot/utils/domainTrace.js';

/**
 * 🌉 Quintero Capsule Adapter
 * The ONLY allowed entry point for the legacy engine to access Quintero logic.
 * Enforces isolation boundaries.
 */

// ✅ LOAD SYSTEM PROMPT
const systemPrompt = fs.readFileSync('/opt/telephony-core/services/client/quintero/openai/prompts/rut-strict.txt', 'utf-8');

// ✅ GUARDRAIL: Validar estrictamente string prompt
function safePrompt(prompt) {
    if (typeof prompt !== 'string') {
        throw new Error(`[DOMAIN ERROR] prompt debe ser string. Recibido: ${typeof prompt} (${JSON.stringify(prompt)})`);
    }
    return prompt;
}

async function quinteroAdapter(ctx) {
    log("info", "🌉 [CAPSULE] Entering Quintero Adapter");

    try {
        if (!ctx.linkedId) {
            ctx.linkedId = ctx.channel?.linkedid || ctx.channel?.id || ctx.channelId || ctx.sessionId;
        }

        // Delegate to internal bot logic
        let result = await quinteroBot(ctx);

        // 🪝 WEBHOOK MIDDLEWARE (Synchronous execution from Engine POV)
        if (result.action && result.action.type === 'WEBHOOK') {
            const hookAction = result.action.action; // e.g. FORMAT_RUT
            const payload = result.action;
            log("info", `🪝 [ADAPTER] Intercepting WEBHOOK action: ${hookAction}`, payload);

            let hookResult = { ok: false, reason: 'UNKNOWN_ACTION' };

            try {
                if (hookAction === 'FORMAT_RUT') {
                    hookResult = await webhookClient.formatRut(payload.rut_raw, ctx.sessionId, ctx.ani, ctx.dnis);
                } else if (hookAction === 'VALIDATE_PATIENT') {
                    hookResult = await webhookClient.validatePatient(payload.rut, ctx.sessionId);
                } else if (hookAction === 'GET_NEXT_AVAILABILITY') {
                    // payload.rut, payload.especialidad
                    hookResult = await webhookClient.getNextAvailability(payload.rut, payload.especialidad, ctx.sessionId);
                } else if (hookAction === 'CONFIRM_AVAILABILITY') {
                    hookResult = await webhookClient.confirmAvailability(ctx.sessionId);
                } else if (hookAction === 'RELEASE_AVAILABILITY') {
                    hookResult = await webhookClient.releaseAvailability(ctx.sessionId);
                } else {
                    log("warn", `⚠️ [ADAPTER] Unknown webhook action: ${hookAction}`);
                }
            } catch (err) {
                log("error", `❌ [ADAPTER] Webhook execution failed: ${err.message}`);
                hookResult = { ok: false, reason: 'EXECUTION_ERROR' };
            }

            // RE-ENTRANT CALL TO DOMAIN WITH RESULT
            log("info", `🪝 [ADAPTER] Webhook executed, feeding back to domain...`, { ok: hookResult.ok });

            result = await quinteroBot({
                ...ctx,
                event: 'WEBHOOK_RESPONSE',
                webhookData: {
                    action: hookAction,
                    data: hookResult
                },
                // Pass updated state if the first call returned it (preserving potential updates)
                state: result.state || ctx.state
            });
        }

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

        // 🔁 Compat: capsule usa skipInput, contrato usa skipUserInput
        if (typeof result.skipInput === 'boolean' && typeof result.skipUserInput !== 'boolean') {
            result.skipUserInput = result.skipInput;
        }

        const before = { ...result };
        const normalized = normalizeDomainResponse(result, ctx.state?.rutPhase);
        
        // Preserve config if provided
        if (result?.config && typeof result.config === 'object') {
            normalized.config = result.config;
        }

        // 🔒 Gobernanza: adapter NO decide negocio; solo asegura consistencia minima
        const normalizedAction = normalized.action?.type ?? normalized.action;
        const isSetState = normalizedAction === 'SET_STATE' || !normalizedAction;

        // 🔐 Regla FSM: nextPhase NO es fase activa si no hay SET_STATE
        const intendedNextPhase = normalized.nextPhase;
        if (!isSetState) {
            const activePhase = result?.phase || ctx.state?.rutPhase;
            if (activePhase) {
                normalized.nextPhase = activePhase;
            }
        }

        if (normalized.nextPhase === 'LISTEN_RUT' && isSetState) {
            normalized.silent = false;
            normalized.skipInput = false;
        }

        // 🔇 Gobernanza: PLAY_AUDIO nunca debe abrir escucha
        if (!isSetState) {
            normalized.skipInput = true;
        }

        domainTrace(log, {
            file: "services/client/quintero/inbound/engine-adapter.js",
            fn: "normalizeDomainResponse",
            event: ctx?.eventType || ctx?.event || "UNKNOWN",
            phaseIn: before?.nextPhase || ctx.state?.rutPhase,
            phaseOut: normalized?.nextPhase,
            action: normalized?.action,
            silent: normalized?.silent,
            skipInput: normalized?.skipInput,
            audio: normalized?.audio,
            tts: normalized?.ttsText,
            nextPhase: intendedNextPhase,
            enableIncremental: normalized?.enableIncremental, // 🎯 CONTRATO: Trazar flags incrementales
            disableIncremental: normalized?.disableIncremental, // 🎯 CONTRATO: Trazar flags incrementales
            diff: {
                silentChanged: before?.silent !== normalized?.silent,
                skipInputChanged: before?.skipInput !== normalized?.skipInput,
                phaseChanged: before?.nextPhase !== normalized?.nextPhase,
                phaseOverridden: intendedNextPhase !== normalized?.nextPhase
            }
        });

        // 🚨 Validacion fatal: LISTEN_RUT requiere silent:false cuando se abre escucha real
        if (normalized.nextPhase === 'LISTEN_RUT' && isSetState && normalized.silent !== false) {
            domainTrace(log, {
                file: "services/client/quintero/inbound/engine-adapter.js",
                fn: "normalizeDomainResponse:critical",
                event: ctx?.eventType || ctx?.event || "UNKNOWN",
                phaseIn: before?.nextPhase || ctx.state?.rutPhase,
                phaseOut: "LISTEN_RUT",
                action: normalized?.action,
                silent: normalized?.silent,
                skipInput: normalized?.skipInput,
                audio: normalized?.audio,
                tts: normalized?.ttsText,
                nextPhase: normalized?.nextPhase,
                level: "CRITICAL",
                reason: "LISTEN_RUT_SILENT_INVALID"
            });
            log("error", "🚨 [CRITICAL] LISTEN_RUT returned silent != false. Applying safe fallback.");
            return normalizeDomainResponse({
                nextPhase: 'LISTEN_RUT',
                audio: 'quintero/ask_rut',
                silent: false,
                skipInput: true,
                allowBargeIn: false,
                action: 'PLAY_AUDIO',
                state: result.state || ctx.state
            }, ctx.state?.rutPhase);
        }
        const errs = assertDomainResponse(normalized);

        if (errs.length > 0) {
            log("warn", `⚠️ [CAPSULE][CONTRACT] Invalid response from bot: ${JSON.stringify(errs)}`, { result });
            // Fail-Closed Fallback: Ask user to repeat or hold, do not crash.
            return normalizeDomainResponse({
                nextPhase: ctx.state?.rutPhase || 'LISTEN_RUT', // Force valid phase
                ttsText: 'Disculpe, hubo un error técnico. ¿Podría repetir?',
                silent: false,
                skipUserInput: false,
                action: { type: 'SET_STATE' },
                state: ctx.state // Preserve state
            });
        }

        // 🛡️ STRICT PHASE ENFORCEMENT
        if (!normalized.nextPhase) {
            log("error", "⛔ [ADAPTER] CRITICAL: Capsule returned undefined phase. Forcing LISTEN_RUT.");
            normalized.nextPhase = 'LISTEN_RUT';
            domainTrace(log, {
                file: "services/client/quintero/inbound/engine-adapter.js",
                fn: "forcePhase",
                event: ctx?.eventType || ctx?.event || "UNKNOWN",
                phaseIn: ctx.state?.rutPhase,
                phaseOut: normalized.nextPhase,
                action: normalized.action,
                silent: normalized.silent,
                skipInput: normalized.skipInput,
                audio: normalized.audio,
                tts: normalized.ttsText,
                nextPhase: normalized.nextPhase
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
            config: normalized.config || result?.config, // Preserve config for listenTimeout
            state: result.state || ctx.state,
            // 🎯 CONTRATO INCREMENTAL: Preservar flags del dominio
            enableIncremental: result.enableIncremental,
            disableIncremental: result.disableIncremental
        };

    } catch (error) {
        log("error", "🌉 💥 [CAPSULE] Error inside Quintero Adapter", error);
        throw error; // Engine handles global errors
    }
}

// Attach system prompt to the adapter function
quinteroAdapter.systemPrompt = systemPrompt;

// ✅ CONFIG: Realtime STT (Fix for NO_INPUT issue)
quinteroAdapter.sttMode = 'realtime';

// ✅ IDENTITY
quinteroAdapter.domainName = 'quintero';

export default quinteroAdapter;
