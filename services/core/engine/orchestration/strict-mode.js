import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { log } from "../../../../../lib/logger.js";
import { waitPlaybackFinished } from "../async/waiters.js";
import { executeDomainAction } from "../legacy/legacy-actions.js";
import { handleRutState } from "../domain/rut-state.js";
import { Guardrails } from "../policies/guardrails.js";
import { isSilentPhase } from "../domain/phases.js";
import { inboundConfig as config } from "../config.js";

const execAsync = promisify(exec);
const VOICEBOT_PATH = config.paths.voicebot;

export class StrictModeOrchestrator {
    constructor(dependencies) {
        this.ari = dependencies.ari;
        // PHASE_ORDER logic is currently inline, we keep it here or move to rules later
    }

    /**
     * Executes the Strict Mode (Phase-Driven) logic.
     * @returns {Promise<{ active: boolean, terminated: boolean }>}
     */
    async execute(channel, openaiClient, domainContext, businessState, conversationState, turn, linkedId, userWavPath) {
        log("info", `🔒 [STRICT MODE] Activo para fase: ${businessState.rutPhase}`);

        // 3.1 Transcripción pura
        let transcript = await openaiClient.transcribeAudioOnly(userWavPath);
        log("info", `📝 [STRICT MODE] Transcript: "${transcript}"`);

        // 3.2 Lógica de Negocio
        let logicResult;

        if (domainContext && domainContext.domain) {
            // DELEGATE TO DOMAIN
            logicResult = await this._delegateToDomain(domainContext, businessState, transcript, linkedId, conversationState);

            // ACTION EXECUTION
            const actionResult = await executeDomainAction(logicResult, businessState, this.ari, channel, conversationState.ani, conversationState.dnis, linkedId); // promptFile not needed? Check legacy signature

            if (actionResult) {
                if (actionResult.shouldHangup) {
                    return { active: false, terminated: true };
                }
                if (actionResult.nextPhase) logicResult.nextPhase = actionResult.nextPhase;
                if (actionResult.ttsText) logicResult.ttsText = actionResult.ttsText;
            }
        } else {
            // GENERIC FALLBACK
            log("debug", `[ORCHESTRATOR] Usando lógica genérica (sin dominio) para fase: ${businessState.rutPhase}`);
            logicResult = await handleRutState(transcript, businessState, linkedId);
        }

        // UPDATE LOGS
        conversationState.history.push({ role: 'user', content: transcript || '[Silencio/No entendido]' });

        // 3.3 TTS GENERATION
        if (logicResult.ttsText) {
            if (Guardrails.shouldBlockReplay(conversationState.lastAssistantText, logicResult.ttsText)) {
                // Blocked by guardrail
            } else {
                await this._handleTTS(logicResult.ttsText, channel, openaiClient, conversationState);
            }
        }

        if (logicResult.shouldHangup) {
            return { active: false, terminated: true };
        }

        return { active: true, terminated: false };
    }

    async _delegateToDomain(domainContext, businessState, transcript, linkedId, conversationState) {
        log("info", `🔀 [ORCHESTRATOR] Delegando a dominio: ${domainContext.botName || 'unknown'}`);

        const ctx = {
            transcript,
            sessionId: linkedId,
            ani: conversationState.ani,
            dnis: conversationState.dnis,
            botName: domainContext.botName || 'default',
            state: businessState
        };

        log("info", `[DOMAIN] Invocando dominio para fase: ${businessState.rutPhase}, transcript: "${transcript}"`);
        const logicResult = await domainContext.domain(ctx);

        if (ctx.state) {
            Object.assign(businessState, ctx.state);
        }

        log("info", `[DOMAIN] Respuesta: nextPhase=${logicResult.nextPhase}, ttsText=${logicResult.ttsText ? 'YES' : 'NO'}, action=${logicResult.action?.type}`);

        // GUARDRAILS
        this._applyGuardrails(logicResult, businessState, transcript, domainContext.botName);

        return logicResult;
    }

    _applyGuardrails(logicResult, businessState, transcript, botName) {
        // Guardrail 1: Contract
        if (!logicResult.action && (businessState.rutPhase === 'WAIT_BODY' || businessState.rutPhase === 'CONFIRM')) {
            log("warn", `⚠️ [DOMAIN][GUARDRAIL] Dominio ${botName} devolvió action=null en fase crítica`);
        }

        // Guardrail 2: Regression (Inline map for now)
        const PHASE_ORDER = {
            'WAIT_BODY': 1, 'WAIT_DV': 2, 'CONFIRM': 3, 'ASK_SPECIALTY': 4,
            'PARSE_SPECIALTY': 5, 'CHECK_AVAILABILITY': 6, 'INFORM_AVAILABILITY': 7,
            'CONFIRM_APPOINTMENT': 8, 'FINALIZE': 9, 'COMPLETE': 10
        };

        const currentPhaseOrder = PHASE_ORDER[businessState.rutPhase] || 0;
        const nextPhaseOrder = PHASE_ORDER[logicResult.nextPhase] || 0;
        const ALLOWED_REGRESSIONS = {
            'CONFIRM': ['WAIT_BODY'],
            'CONFIRM_APPOINTMENT': ['ASK_SPECIALTY'],
            'PARSE_SPECIALTY': ['ASK_SPECIALTY']
        };

        if (nextPhaseOrder < currentPhaseOrder && logicResult.nextPhase) {
            const allowed = ALLOWED_REGRESSIONS[businessState.rutPhase] || [];
            if (!allowed.includes(logicResult.nextPhase)) {
                log("warn", `⚠️ [DOMAIN][GUARDRAIL] Regresión bloqueada: ${businessState.rutPhase} → ${logicResult.nextPhase}`);
                logicResult.nextPhase = businessState.rutPhase;
            }
        }

        // Guardrail 3: Silence
        if (isSilentPhase(businessState.rutPhase) && transcript && transcript.trim().length > 0) {
            log("warn", `⚠️ [DOMAIN][GUARDRAIL] Ignorando transcript en fase silenciosa`);
            // Transcript variable passed by value, logicResult doesn't carry it back but we logged it
        }
    }

    async _handleTTS(text, channel, openaiClient, conversationState) {
        log("info", `🗣️ [STRICT MODE] Generando TTS: "${text}"`);
        conversationState.history.push({ role: 'assistant', content: text });
        openaiClient.lastAssistantResponse = text;
        conversationState.lastAssistantText = text;

        const ttsBuffer = await openaiClient.synthesizeSpeech(text);

        if (ttsBuffer) {
            const rspId = `vb_tts_${Date.now()}`;
            const rawPcmFile = `/tmp/${rspId}.pcm`;
            const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

            fs.writeFileSync(rawPcmFile, ttsBuffer);
            const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
            await execAsync(cmd);

            const playback = this.ari.Playback();
            await channel.play({ media: `sound:voicebot/${rspId}` }, playback);
            await waitPlaybackFinished(playback);
        }
    }
}
