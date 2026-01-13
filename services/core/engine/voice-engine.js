// =========================================================
// VOICEBOT ENGINE V3 — MINIMAL, DETERMINISTIC, SAFE
// =========================================================

import fs from "fs";
import { log } from "../../../lib/logger.js";
import { OpenAIRealtimeClientV3 } from "./openai-client.js";
import { playWithBargeIn, waitForRealVoice, recordUserTurn } from "./legacy/legacy-helpers.js";
import { CallFinalizer } from "./services/call-finalizer.js";
import { inboundConfig as config } from "./config.js";

const MAX_TURNS = config.engine.maxTurns || 15;
const MAX_SILENT_TURNS = config.engine.maxSilentTurns || 3;
const MIN_AUDIO_BYTES = config.audio.minWavSizeBytes || 6000;

export async function startVoiceBotSessionV3(
    ari,
    channel,
    ani,
    dnis,
    linkedId,
    promptFile,
    domainContext // OBLIGATORIO
) {
    log("info", `🤖 [ENGINE V3] Session start ${linkedId}`);

    const engineState = {
        active: true,
        turn: 0,
        silentCount: 0
    };

    const conversationState = {
        history: [],
        terminated: false
    };

    const openaiClient = new OpenAIRealtimeClientV3({
        voice: config.openai.voice,
        language: config.openai.language,
        model: config.openai.model,
        instructions: domainContext.systemPrompt
    });

    try {
        await openaiClient.connect();
    } catch (err) {
        log("error", `❌ OpenAI connect failed: ${err.message}`);
        return;
    }

    channel.on("StasisEnd", () => {
        log("info", `👋 Channel hangup ${linkedId}`);
        engineState.active = false;
        openaiClient.disconnect();
    });

    // =======================================================
    // TURN 0 — GREETING (DOMAIN OWNED)
    // =======================================================
    try {
        const greetCtx = buildDomainCtx("", domainContext, ari, channel, ani, dnis, linkedId);
        const greetResult = await domainContext.domain(greetCtx);

        applyDomainResult(greetResult, openaiClient, conversationState, ari, channel);
        if (greetResult?.shouldHangup) {
            engineState.active = false;
        }
    } catch (err) {
        log("error", `❌ Greeting error: ${err.message}`);
        engineState.active = false;
    }

    // =======================================================
    // MAIN LOOP
    // =======================================================
    while (engineState.active && engineState.turn < MAX_TURNS) {
        engineState.turn++;

        log("info", `🔄 Turn ${engineState.turn}`);

        const voiceDetected = await waitForRealVoice(channel, {
            maxWaitMs: config.audio.maxWaitMs || 4000,
            minTalkingEvents: 1
        });

        if (!voiceDetected.detected) {
            engineState.silentCount++;

            if (engineState.silentCount >= MAX_SILENT_TURNS) {
                log("warn", "🛑 Max silence reached");
                break;
            }

            await delegateDomainSilence(domainContext, openaiClient, conversationState, ari, channel, ani, dnis, linkedId);
            continue;
        }

        engineState.silentCount = 0;

        const rec = await recordUserTurn(channel, engineState.turn);
        if (!rec.ok) {
            log("warn", `⚠️ Recording failed (${rec.reason})`);
            continue;
        }

        const stats = fs.statSync(rec.path);
        if (stats.size < MIN_AUDIO_BYTES) {
            log("warn", `🤫 Audio too small (${stats.size} bytes)`);
            await delegateDomainSilence(domainContext, openaiClient, conversationState, ari, channel, ani, dnis, linkedId);
            continue;
        }

        // TRANSCRIBE
        await openaiClient.processAudio(rec.path);
        const transcript = await openaiClient.waitForTranscript();

        const ctx = buildDomainCtx(transcript, domainContext, ari, channel, ani, dnis, linkedId);
        const domainResult = await domainContext.domain(ctx);

        applyDomainResult(domainResult, openaiClient, conversationState, ari, channel);

        if (domainResult?.shouldHangup) {
            engineState.active = false;
            break;
        }
    }

    // =======================================================
    // FINALIZE
    // =======================================================
    openaiClient.disconnect();
    log("info", `🔚 Session end ${linkedId}`);

    await CallFinalizer.finalize(
        ari,
        channel,
        conversationState,
        { silentTurns: engineState.silentCount },
        domainContext.state || {}
    );
}

// =======================================================
// HELPERS
// =======================================================

function buildDomainCtx(transcript, domainContext, ari, channel, ani, dnis, linkedId) {
    return {
        transcript,
        sessionId: linkedId,
        ani,
        dnis,
        state: domainContext.state,
        ari,
        channel
    };
}

async function delegateDomainSilence(domainContext, openaiClient, conversationState, ari, channel, ani, dnis, linkedId) {
    const ctx = buildDomainCtx("", domainContext, ari, channel, ani, dnis, linkedId);
    const result = await domainContext.domain(ctx);
    applyDomainResult(result, openaiClient, conversationState, ari, channel);
}

function applyDomainResult(result, openaiClient, conversationState, ari, channel) {
    if (!result) return;

    if (result.ttsText) {
        openaiClient.sendSystemText(result.ttsText);
        conversationState.history.push({ role: "assistant", content: result.ttsText });
    }

    if (result.soundFile) {
        playWithBargeIn(ari, channel, result.soundFile, openaiClient, { bargeIn: false });
    }
}
