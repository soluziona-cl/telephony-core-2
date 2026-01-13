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
        silentCount: 0,
        skipInput: false // ✅ New Flag for Silent Loop
    };

    const conversationState = {
        history: [],
        terminated: false,
        startTime: new Date()
    };

    // Ensure domain state is initialized
    domainContext.state = domainContext.state || {};

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
    // 🚀 INITIALIZATION (INIT EVENT)
    // =======================================================
    try {
        const initCtx = buildDomainCtx("", domainContext, ari, channel, ani, dnis, linkedId);

        // 1️⃣ SEND INIT EVENT
        log("info", `📢 [ENGINE] Sending INIT event`);
        const initResult = await domainContext.domain({
            ...initCtx,
            event: 'INIT'
        });

        // 2️⃣ UPDATE STATE & APPLY RESULT
        if (initResult) {
            if (initResult.state) domainContext.state = initResult.state;
            // Check for silent transition immediately
            engineState.skipInput = initResult.silent === true;
            domainContext.lastResult = initResult;
        }

        await applyDomainResult(initResult, openaiClient, conversationState, ari, channel);

        if (initResult?.shouldHangup || initResult?.action === 'HANGUP') {
            engineState.active = false;
        }

    } catch (err) {
        log("error", `❌ Init error: ${err.message}`);
        engineState.active = false;
    }

    // =======================================================
    // 🔄 MAIN LOOP
    // =======================================================
    while (engineState.active && engineState.turn < MAX_TURNS) {
        engineState.turn++;
        log("info", `🔄 Turn ${engineState.turn}`);

        let transcript = "";

        // 🛑 SILENT MODE CHECK
        if (engineState.skipInput) {
            log("info", "⏩ [ENGINE] Silent Turn: Skipping Input & STT");
            engineState.skipInput = false; // Reset, domain must re-assert silent each time if needed
        } else {
            // 👂 NORMAL LISTENING MODE
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

                await delegateDomainEvent('NO_INPUT', domainContext, openaiClient, conversationState, ari, channel, ani, dnis, linkedId);
                // Check if NO_INPUT handler requested silent mode for retry
                if (domainContext.lastResult?.silent) {
                    engineState.skipInput = true;
                }
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
                await delegateDomainEvent('NO_INPUT', domainContext, openaiClient, conversationState, ari, channel, ani, dnis, linkedId);
                if (domainContext.lastResult?.silent) {
                    engineState.skipInput = true;
                }
                continue;
            }

            // TRANSCRIBE
            await openaiClient.processAudio(rec.path);
            transcript = await openaiClient.waitForTranscript();
        }

        // 3️⃣ REGULAR TURN
        const ctx = buildDomainCtx(transcript, domainContext, ari, channel, ani, dnis, linkedId);
        const domainResult = await domainContext.domain({
            ...ctx,
            event: 'TURN'
        });

        // UPDATE STATE
        if (domainResult) {
            if (domainResult.state) domainContext.state = domainResult.state;
            // ✅ UPDATE SKIP INPUT FLAG
            engineState.skipInput = domainResult.silent === true;
            // Store last result for checks
            domainContext.lastResult = domainResult;
        }

        await applyDomainResult(domainResult, openaiClient, conversationState, ari, channel);

        if (domainResult?.shouldHangup || domainResult?.action === 'HANGUP') {
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

async function delegateDomainEvent(eventType, domainContext, openaiClient, conversationState, ari, channel, ani, dnis, linkedId) {
    const ctx = buildDomainCtx("", domainContext, ari, channel, ani, dnis, linkedId);
    const result = await domainContext.domain({
        ...ctx,
        event: eventType
    });

    if (result) {
        if (result.state) domainContext.state = result.state;
        domainContext.lastResult = result;
    }

    await applyDomainResult(result, openaiClient, conversationState, ari, channel);
}

async function applyDomainResult(result, openaiClient, conversationState, ari, channel) {
    if (!result) return;

    // NORMALIZE ACTION
    // Handles { action: 'PLAY_AUDIO', audio: 'path' } vs { action: 'SAY_TEXT', text: '...' }
    // Also supports legacy formats for backward compatibility via 'adapter' logic if strictly needed,
    // but we prefer strict here.

    const action = result.action || 'WAIT_INPUT'; // Default
    const silent = result.silent === true; // Check silence for barge-in control

    // 1. AUDIO PLAYBACK (Implicit or Explicit)
    const audioFile = result.audio || result.soundFile;
    if (action === 'PLAY_AUDIO' || audioFile) {
        if (audioFile) {
            log("info", `▶️ Playing Audio: ${audioFile} (BargeIn=${!silent})`);
            // ✅ IF SILENT=TRUE (No Input Expected), DISABLE BARGE-IN to prevent interruption
            await playWithBargeIn(ari, channel, audioFile, openaiClient, { bargeIn: !silent });
        }
    }

    // 2. TTS / TEXT (Implicit or Explicit)
    const textToSay = result.text || result.ttsText;
    if ((action === 'SAY_TEXT' || textToSay) && !audioFile) {
        // Only say text if no audio file was provided (priority to audio)
        // OR if action explicitly allows it.
        // For now, consistent with legacy: if text exists, send it.
        // BUT strict mode: 'sound:...' should be handled by domain returning audio property, not ttsText.

        if (textToSay) {
            // Guardrail: Detect "sound:" in text and block it
            if (textToSay.startsWith("sound:")) {
                log("warn", `⚠️ [ENGINE] Domain returned 'sound:' in text. This should be 'audio' property. Ignoring TTS.`);
            } else {
                log("info", `🗣️ TTS: "${textToSay}"`);
                openaiClient.sendSystemText(textToSay);
                conversationState.history.push({ role: "assistant", content: textToSay });
            }
        }
    }

    // 3. HANGUP
    if (action === 'HANGUP' || result.shouldHangup) {
        log("info", "🛑 Domain requested HANGUP");
    }
}
