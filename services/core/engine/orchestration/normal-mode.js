import fs from "fs";
import { log } from "../../../../../lib/logger.js";
import { Guardrails } from "../policies/guardrails.js";
import { processUserTurnWithOpenAI, playWithBargeIn } from "../legacy/legacy-helpers.js";
import { runBusinessLogic } from "../legacy/legacy-business.js";
import { inboundConfig as config } from "../config.js";
import { pollUntil } from "../async/polling.js";
import { TerminationPolicy } from "../policies/termination-policy.js";
async function waitForTranscript(client, timeoutMs = 2500) {
    const result = await pollUntil(() => client.lastTranscript, { timeoutMs, intervalMs: 100 });
    return result || "";
}

export class NormalModeOrchestrator {
    constructor(dependencies) {
        this.ari = dependencies.ari;
        this.terminationPolicy = new TerminationPolicy();
    }

    /**
     * Executes the Normal Mode (Conversational) logic.
     * @returns {Promise<{ active: boolean }>}
     */
    async execute(channel, openaiClient, businessState, conversationState, turn, linkedId, userWavPath) {
        // 🛡️ GUARDRAILS
        if (Guardrails.shouldBlockInvalidComplete(businessState.rutPhase, businessState.rutFormatted)) {
            return { active: false };
        }

        if (Guardrails.shouldBlockFallback(turn, businessState.rutFormatted, businessState.rutPhase)) {
            return { active: false };
        }

        // 3.1 PROCESS WITH OPENAI REALTIME
        const responseBaseName = await processUserTurnWithOpenAI(userWavPath, openaiClient);

        if (!conversationState.active) {
            log("info", `🔚[NORMAL MODE] Sesión terminada durante OpenAI`);
            return { active: false };
        }

        if (!responseBaseName) {
            log("warn", `⚠️[NORMAL MODE] Sin respuesta OpenAI`);
        }

        // 3.2 PLAYBACK WITH BARGE-IN
        if (responseBaseName) {
            const assistantResponse = openaiClient.lastAssistantResponse || '';
            const isCriticalResponse = /rut|confirmar|registrado|encontrado|id de reserva/i.test(assistantResponse);
            const allowBargeIn = !isCriticalResponse && !businessState.disableBargeIn;

            if (isCriticalResponse) log("info", `🛡️ [BVDA/NORMAL] Critical response, disabling barge-in.`);

            await playWithBargeIn(this.ari, channel, responseBaseName, openaiClient, { bargeIn: allowBargeIn });

            // 3.2.1 FAREWELL CHECK (Domain Signal)
            if (this.terminationPolicy.shouldEnd(assistantResponse)) {
                log("info", `👋 [NORMAL MODE] Farewell detected in response: "${assistantResponse}"`);
                // Allow a small delay for audio to finish if needed, though waitPlaybackFinished should handle it in playWithBargeIn
                // But playWithBargeIn returns, meaning audio is done or barged-in.
                return { active: false, reason: 'farewell' };
            }
        }

        // 3.3 GET TRANSCRIPT (Async/Polling)
        let transcript = await waitForTranscript(openaiClient);

        // Fallback Whisper
        const audioStats = fs.statSync(userWavPath);
        if ((!transcript || transcript.trim().length === 0) && audioStats.size > 8000) {
            transcript = await openaiClient.transcribeAudioWithWhisper(userWavPath);
        }

        // UPDATE HISTORY
        conversationState.history.push({ role: 'user', content: transcript || '[...]' });
        if (openaiClient.lastAssistantResponse) {
            conversationState.history.push({ role: 'assistant', content: openaiClient.lastAssistantResponse });
        }

        // 3.4 BUSINESS LOGIC (Legacy / Agenda / Transfers)
        await runBusinessLogic(
            transcript,
            openaiClient.lastAssistantResponse,
            businessState,
            conversationState,
            this.ari,
            channel,
            openaiClient,
            linkedId
        );

        return { active: conversationState.active };
    }
}
