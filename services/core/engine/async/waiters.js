/**
 * Waiters for event-based operations.
 */

/**
 * Waits for a playback to finish or times out.
 * @param {Object} playback - The ARI playback object
 * @param {number} timeoutMs - Max time to wait (default 5000ms)
 * @returns {Promise<string>} 'finished' or 'timeout'
 */
export function waitPlaybackFinished(playback, timeoutMs = 5000) {
    return new Promise(resolve => {
        let done = false;

        const onFinished = () => {
            if (!done) {
                done = true;
                resolve('finished');
            }
        };

        playback.once('PlaybackFinished', onFinished);

        setTimeout(() => {
            if (!done) {
                done = true;
                // Cleanup listener if possible, though 'once' handles it mostly.
                // playback.removeListener('PlaybackFinished', onFinished); 
                resolve('timeout');
            }
        }, timeoutMs);
    });
}
