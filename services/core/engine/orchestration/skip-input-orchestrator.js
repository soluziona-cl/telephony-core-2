import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { log } from "../../../../lib/logger.js";
import { waitPlaybackFinished } from "../async/waiters.js";
import { inboundConfig as config } from "../config.js";

const execAsync = promisify(exec);
const VOICEBOT_PATH = config.paths.voicebot;

export class SkipInputOrchestrator {
    constructor(dependencies) {
        this.ari = dependencies.ari;
        this.PHASES = dependencies.PHASES || {};
    }

    /**
     * Checks if the current phase warrants skipping user input (Silent Phase).
     * If so, executes the domain logic (TTS, State Updates, Hangup) immediately.
     * 
     * @param {Object} channel - ARI Channel
     * @param {Object} openaiClient - Active OpenAI Client
     * @param {Object} domainContext - { domain, botName }
     * @param {Object} businessState - Mutable state
     * @param {Object} conversationState - Mutable history/active state
     * @param {number} turn - Current turn number
     * @param {string} linkedId - Call ID for logging
     * @returns {Promise<{ shouldSkip: boolean, nextPhase: string|null }>}
     */
    async checkAndExecute(channel, openaiClient, domainContext, businessState, conversationState, turn, linkedId) {
        let shouldSkipUserInput = false;
        let skipUserInputResult = null;

        if (domainContext && domainContext.domain) {
            // 🛡️ PRE-CHECK: If phase requires input, do NOT ask domain (unless turn 1 exception)
            const phaseConfig = this.PHASES[businessState.rutPhase];
            const phaseRequiresInput = phaseConfig ? phaseConfig.requiresInput : false;

            if (phaseRequiresInput && turn > 1) {
                log("debug", `🛡️ [ORCHESTRATOR] Phase ${businessState.rutPhase} requires input. Skipping domain check.`);
                shouldSkipUserInput = false;
            } else {
                // Consult Domain
                const ctx = {
                    transcript: "",
                    sessionId: linkedId,
                    ani: conversationState.ani || '', // specific to implementation
                    dnis: conversationState.dnis || '',
                    botName: domainContext.botName || 'default',
                    state: businessState
                };

                log("debug", `[ORCHESTRATOR] Consulting domain for phase: ${businessState.rutPhase}`);
                skipUserInputResult = await domainContext.domain(ctx);

                // Update State
                if (ctx.state) {
                    Object.assign(businessState, ctx.state);
                }

                shouldSkipUserInput = skipUserInputResult.skipUserInput === true;
            }

            if (shouldSkipUserInput) {
                log("info", `🔇 [ORCHESTRATOR] SkipInput=true for ${businessState.rutPhase}. Executing domain logic.`);
                log("debug", `[ORCHESTRATOR] Domain Result: nextPhase=${skipUserInputResult.nextPhase}, action=${skipUserInputResult.action?.type}`);

                // Execute Action
                if (skipUserInputResult.action && skipUserInputResult.action.type) {
                    await this._handleAction(skipUserInputResult, businessState, conversationState, channel, openaiClient);
                }

                // Handle TTS / Playback
                if (conversationState.terminated) {
                    log("debug", "[ORCHESTRATOR] Conversation terminated, skipping TTS.");
                } else if (skipUserInputResult.ttsText) {
                    await this._handleTTS(skipUserInputResult.ttsText, channel, openaiClient, conversationState);
                }

                // Auto-Advance Logic
                if (skipUserInputResult.nextPhase && skipUserInputResult.nextPhase !== businessState.rutPhase) {
                    log("info", `🚀 [ORCHESTRATOR] Auto-advance: ${businessState.rutPhase} → ${skipUserInputResult.nextPhase}`);
                    businessState.rutPhase = skipUserInputResult.nextPhase;
                }

                return { shouldSkip: true, nextPhase: skipUserInputResult.nextPhase };
            }
        }

        return { shouldSkip: false, nextPhase: null };
    }

    async _handleAction(result, businessState, conversationState, channel, openaiClient) {
        const action = result.action;
        switch (action.type) {
            case 'SET_STATE':
                if (action.payload.updates) {
                    Object.assign(businessState, action.payload.updates);
                    log("info", `[ORCHESTRATOR] State updated via SET_STATE`);
                }
                break;

            case 'END_CALL':
                log("info", `[ORCHESTRATOR] END_CALL triggered: ${action.payload.reason || 'COMPLETE'}`);

                // Sync Playback for Goodbye if text provided
                if (result.ttsText) {
                    await this._handleTTS(result.ttsText, channel, openaiClient, conversationState, true);
                    result.ttsText = null; // Prevent double playback
                }

                log("info", "[ORCHESTRATOR] Hanging up after END_CALL action");
                conversationState.active = false;
                conversationState.terminated = true;
                try {
                    await channel.hangup();
                } catch (e) {
                    const msg = (e.message || '').toLowerCase();
                    if (!msg.includes('channel not found') && !msg.includes('404')) {
                        log("warn", `[ORCHESTRATOR] Hangup error: ${e.message}`);
                    }
                }
                break;
        }
    }

    async _handleTTS(text, channel, openaiClient, conversationState, isFinal = false) {
        log("info", `🗣️ [ORCHESTRATOR] Generating TTS: "${text}"`);
        conversationState.history.push({ role: 'assistant', content: text });
        openaiClient.lastAssistantResponse = text;

        const ttsBuffer = await openaiClient.synthesizeSpeech(text);
        if (ttsBuffer) {
            const rspId = `vb_tts_${Date.now()}`;
            const rawPcmFile = `/tmp/${rspId}.pcm`;
            const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

            fs.writeFileSync(rawPcmFile, ttsBuffer);
            // Convert PCM to WAV 8k
            const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
            await execAsync(cmd);

            const playback = this.ari.Playback();
            await channel.play({ media: `sound:voicebot/${rspId}` }, playback);

            // Wait for playback to finish
            const timeout = isFinal ? 6000 : 5000;
            await waitPlaybackFinished(playback, timeout);
        }
    }
}
