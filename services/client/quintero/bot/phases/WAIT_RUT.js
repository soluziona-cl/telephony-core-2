import { log } from '../../../../../lib/logger.js';

/**
 * 🤖 WAIT_RUT Phase (Client-Specific)
 * Handles the logic for requesting and validating the RUT.
 * 
 * Rules:
 * - Play 'ask_rut' audio on entry.
 * - Listen with Batch STT (silent: false).
 * - Retry on invalid format / silence (max 2 retries).
 * - Delegates validation to Webhook.
 */

const MAX_RETRIES = 2; // 0 (Ask), 1 (Retry 1), 2 (Retry 2 / Fail)

export async function waitRutPhase(ctx) {
    const { transcript, state, event, webhookData } = ctx;
    const retryCount = state.retryCount || 0;

    log('info', `[QUINTERO] Phase: WAIT_RUT (Retry: ${retryCount})`, { event, transcript });

    // 1️⃣ INITIAL ENTRY (First Ask)
    // Runs only if we haven't asked yet (rutInitialized flag or specific state check)
    // We expect state.rutInitialized to be undefined initially.
    if (event === 'INIT' || !state.rutInitialized) {
        return {
            audio: 'quintero/ask_rut',
            nextPhase: 'WAIT_RUT',
            action: 'PLAY_AUDIO',
            silent: false, // 🔓 Allow Barge-In & Listen immediately
            allowBargeIn: true,
            statePatch: { rutInitialized: true, retryCount: 0 },
            config: {
                listenTimeout: 6000 // ⏳ Extended timeout for "14 millones..."
            }
        };
    }

    // 2️⃣ HANDLE WEBHOOK RESPONSE (Format Validation)
    if (event === 'WEBHOOK_RESPONSE' && webhookData?.action === 'FORMAT_RUT') {
        const data = webhookData.data;
        if (data.ok && data.rut) {
            // ✅ RUT Valid -> Proceed to Validation
            return {
                action: {
                    type: 'WEBHOOK',
                    action: 'VALIDATE_PATIENT',
                    rut: data.rut
                },
                nextPhase: 'HANDLE_VALIDATE_PATIENT', // Transition out of WAIT_RUT
                silent: true,
                statePatch: { dni: data.rut, retryCount: 0 }
            };
        } else {
            // ❌ Invalid Format -> Retry
            return handleRetry(retryCount, 'format_error');
        }
    }

    // 3️⃣ HANDLE INPUT (Silence or Text)
    if (!transcript || transcript.trim().length === 0) {
        // 🤫 Silence -> Retry
        if (event === 'NO_INPUT') {
            return handleRetry(retryCount, 'silence');
        }
        // Just started listening or empty turn?
        // If we are here, it means we are in 'TURN' but normalized transcript is empty
        // In Batch/Legacy, we usually get NO_INPUT from Engine if empty.
        // If we get here, it implies engine sent empty transcript?
        return {
            nextPhase: 'WAIT_RUT',
            action: 'USE_ENGINE',
            silent: false, // Ensure STT is active
            skipUserInput: false
        };
    }

    // 🗣️ We have text -> Send to FORMAT_RUT Webhook
    return {
        action: {
            type: 'WEBHOOK',
            action: 'FORMAT_RUT',
            rut_raw: transcript
        },
        nextPhase: 'WAIT_RUT', // Stay here waiting for webhook response
        silent: true, // Processing webhook, be silent (or play processing sound?)
        statePatch: { lastTranscript: transcript }
    };
}

function handleRetry(currentCount, reason) {
    const nextCount = currentCount + 1;

    if (nextCount > MAX_RETRIES) { // > 2 implies we failed 0, 1, 2. But we define MAX as total attempts or retries? 
        // Logic: 0 (Init), 1 (Retry 1), 2 (Retry 2) -> Fail.
        // So if current is 2, next is 3 -> Fail.
        // Variable says MAX_RETRIES = 2.
        log('warn', `[QUINTERO] Max retries reached (${reason}). Hanging up.`);
        return {
            audio: 'quintero/goodbye_failure', // Assuming existence, or generic
            ttsText: 'Lo siento, no he podido entender su RUT. Por favor intente más tarde.',
            nextPhase: 'END',
            action: 'HANGUP',
            shouldHangup: true
        };
    }

    log('info', `[QUINTERO] Retrying (${reason}) - Attempt ${nextCount}`);

    // If reason is silence, maybe use specific "I didn't hear you".
    // If format error, "Format invalid".
    // For now, mapping to standard retry.

    // NOTE: 'quintero/ask_rut_retry' should say: "Por favor dígame su RUT, por ejemplo..."

    return {
        audio: 'quintero/ask_rut_retry',
        nextPhase: 'WAIT_RUT',
        action: 'PLAY_AUDIO',
        silent: false, // 🔓 Listen immediately
        allowBargeIn: true,
        statePatch: { retryCount: nextCount },
        config: {
            listenTimeout: 6000
        }
    };
}
