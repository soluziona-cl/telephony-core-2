/**
 * Semantic delays for the engine.
 * Encapsulates technical timeouts.
 */

// Private primitive
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Public Semantic Delays

/**
 * Standard safety delay to allow IVR/RTP to settle.
 */
export async function ivrSafetyDelay(ms = 600) {
    await sleep(ms);
}

/**
 * Short delay for rapid turn-taking or retries.
 */
export async function shortTurnDelay(ms = 200) {
    await sleep(ms);
}

/**
 * General purpose workaround delay (use sparingly and document why).
 */
export async function technicalWorkaroundDelay(ms = 500) {
    await sleep(ms);
}

/**
 * Delay used when waiting for a recording to finalize.
 */
export async function recordingSettlementDelay(ms = 500) {
    await sleep(ms);
}
