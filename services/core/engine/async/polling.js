/**
 * Reusable polling logic.
 */

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls a function until it returns a truthy value or timeout is reached.
 * @param {Function} fn - The function to poll (synchronous)
 * @param {Object} options
 * @param {number} options.timeoutMs - Max total time to wait
 * @param {number} options.intervalMs - Time between checks
 * @returns {Promise<any>} The result of fn() or null if timeout
 */
export async function pollUntil(fn, { timeoutMs = 2500, intervalMs = 100 } = {}) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const result = fn();
        if (result) return result;
        await sleep(intervalMs);
    }
    return null;
}
