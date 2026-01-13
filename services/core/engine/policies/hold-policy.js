/**
 * HoldPolicy - Manages HOLD state with music-on-hold
 * 
 * Purpose: Enable HOLD feature for silent phases to improve UX
 * during processing delays (e.g., webhook calls, DB queries).
 * 
 * Governance: CORE module - no client-specific logic
 * 
 * Feature Flag: Disabled by default, can be enabled per-client via config
 */

import { log } from '../../../../lib/logger.js';

export class HoldPolicy {
    constructor(config = {}) {
        this.enabled = config.enableHold || false;
        this.enterOnFirstSilence = config.enterOnFirstSilence !== false; // Default: true
        this.maxHoldDurationMs = config.maxHoldDurationMs || 30000; // 30 seconds
        this.musicClass = config.musicClass || 'default';
    }

    /**
     * Determine if we should enter HOLD state
     * 
     * @param {SessionContext} session - Current session
     * @param {string} currentPhase - Current domain phase
     * @param {Object} PHASES - Phase configuration map
     * @returns {boolean}
     */
    shouldEnter(session, currentPhase, PHASES = {}) {
        if (!this.enabled) {
            return false;
        }

        if (session.inHold) {
            return false; // Already in HOLD
        }

        if (session.terminated) {
            return false; // Don't enter HOLD if terminating
        }

        // Only enter HOLD in silent phases (phases that don't require user input)
        const phaseConfig = PHASES[currentPhase];
        const isSilentPhase = phaseConfig && !phaseConfig.requiresInput;

        if (!isSilentPhase) {
            return false;
        }

        // Enter on first silence in silent phase
        if (this.enterOnFirstSilence && session.consecutiveSilences === 1) {
            log('info', `🎵 [HOLD] Conditions met: silent phase="${currentPhase}", silence=${session.consecutiveSilences}`);
            return true;
        }

        return false;
    }

    /**
     * Enter HOLD state and start music-on-hold
     * 
     * @param {SessionContext} session
     * @param {ChannelControl} channelControl
     */
    async enter(session, channelControl) {
        if (session.inHold) {
            log('debug', '[HOLD] Already in HOLD state, skipping');
            return;
        }

        log('info', `🎵 [HOLD] Entering HOLD state (musicClass: ${this.musicClass})`);

        session.inHold = true;
        session.holdEnteredAt = Date.now();

        try {
            await channelControl.startMOH(this.musicClass);
        } catch (err) {
            log('error', `❌ [HOLD] Failed to start MOH: ${err.message}`);
            // Don't fail the call, just mark as not in hold
            session.inHold = false;
            session.holdEnteredAt = null;
        }
    }

    /**
     * Determine if we should exit HOLD state
     * 
     * @param {SessionContext} session
     * @param {boolean} voiceDetected
     * @returns {boolean}
     */
    shouldExit(session, voiceDetected) {
        if (!session.inHold) {
            return false;
        }

        // Exit on voice detection
        if (voiceDetected) {
            log('info', '🗣️ [HOLD] Voice detected, exiting HOLD');
            return true;
        }

        // Exit on timeout
        const holdDuration = Date.now() - session.holdEnteredAt;
        if (holdDuration > this.maxHoldDurationMs) {
            log('warn', `⏰ [HOLD] Max hold duration (${this.maxHoldDurationMs}ms) exceeded`);
            return true;
        }

        return false;
    }

    /**
     * Exit HOLD state and stop music-on-hold
     * 
     * @param {SessionContext} session
     * @param {ChannelControl} channelControl
     */
    async exit(session, channelControl) {
        if (!session.inHold) {
            log('debug', '[HOLD] Not in HOLD state, skipping exit');
            return;
        }

        const holdDuration = Date.now() - session.holdEnteredAt;
        log('info', `🔇 [HOLD] Exiting HOLD state (duration: ${holdDuration}ms)`);

        try {
            await channelControl.stopMOH();
        } catch (err) {
            log('error', `❌ [HOLD] Failed to stop MOH: ${err.message}`);
        }

        session.inHold = false;
        session.holdEnteredAt = null;
    }

    /**
     * Get current HOLD status
     */
    getStatus(session) {
        if (!session.inHold) {
            return { inHold: false };
        }

        const duration = Date.now() - session.holdEnteredAt;
        return {
            inHold: true,
            durationMs: duration,
            remainingMs: Math.max(0, this.maxHoldDurationMs - duration)
        };
    }
}
