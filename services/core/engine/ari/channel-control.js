/**
 * ChannelControl - Manages Asterisk channel operations
 * 
 * Purpose: Isolate all ARI channel control operations (MOH, hangup, state checks)
 * to prevent direct channel manipulation in engine logic.
 * 
 * Governance: CORE module - no client-specific logic
 */

import { log } from '../../../../lib/logger.js';

export class ChannelControl {
    constructor(ari, channel) {
        this.ari = ari;
        this.channel = channel;
        this.channelId = channel.id;
    }

    /**
     * Start music-on-hold
     * 
     * @param {string} musicClass - MOH class from musiconhold.conf
     */
    async startMOH(musicClass = 'default') {
        try {
            await this.channel.startMoh({ mohClass: musicClass });
            log('info', `🎵 [MOH] Started music-on-hold: ${musicClass} (channel: ${this.channelId})`);
            return true;
        } catch (err) {
            log('error', `❌ [MOH] Failed to start: ${err.message}`);
            return false;
        }
    }

    /**
     * Stop music-on-hold
     */
    async stopMOH() {
        try {
            await this.channel.stopMoh();
            log('info', `🔇 [MOH] Stopped music-on-hold (channel: ${this.channelId})`);
            return true;
        } catch (err) {
            log('error', `❌ [MOH] Failed to stop: ${err.message}`);
            return false;
        }
    }

    /**
     * Hangup channel (idempotent)
     */
    async hangup() {
        try {
            // Check if channel is still alive before hanging up
            const state = await this.channel.get();

            if (!state || state.state === 'Down') {
                log('debug', `🔇 [CHANNEL] Already down, skipping hangup: ${this.channelId}`);
                return true;
            }

            await this.channel.hangup();
            log('info', `📞 [CHANNEL] Hangup successful: ${this.channelId}`);
            return true;

        } catch (err) {
            // Benign error - channel may have been hung up externally
            if (err.message && err.message.includes('not found')) {
                log('debug', `🔇 [CHANNEL] Not found (already hung up): ${this.channelId}`);
                return true;
            }

            log('warn', `⚠️ [CHANNEL] Hangup error: ${err.message}`);
            return false;
        }
    }

    /**
     * Check if channel is alive
     * 
     * @returns {boolean}
     */
    async isAlive() {
        try {
            const state = await this.channel.get();
            const alive = state && state.state !== 'Down';

            if (!alive) {
                log('debug', `🔇 [CHANNEL] Channel is down: ${this.channelId}`);
            }

            return alive;
        } catch (err) {
            log('debug', `🔇 [CHANNEL] State check failed (assuming down): ${err.message}`);
            return false;
        }
    }

    /**
     * Get channel state
     * 
     * @returns {Object|null}
     */
    async getState() {
        try {
            return await this.channel.get();
        } catch (err) {
            log('debug', `[CHANNEL] Failed to get state: ${err.message}`);
            return null;
        }
    }

    /**
     * Play silence (keep-alive)
     * 
     * @param {number} durationSeconds
     */
    async playSilence(durationSeconds = 1) {
        try {
            await this.channel.play({ media: `sound:silence/${durationSeconds}` });
            log('debug', `⏱️ [KEEP-ALIVE] Played ${durationSeconds}s silence`);
            return true;
        } catch (err) {
            log('warn', `⚠️ [KEEP-ALIVE] Failed to play silence: ${err.message}`);
            return false;
        }
    }
}
