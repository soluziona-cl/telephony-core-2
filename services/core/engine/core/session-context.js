/**
 * SessionContext - Encapsulates mutable session state
 * 
 * Purpose: Centralize all session-level state to reduce scattered variables
 * and improve testability.
 * 
 * Governance: CORE module - no client-specific logic
 */

import { log } from '../../../../lib/logger.js';

export class SessionContext {
    constructor(linkedId, ani, dnis) {
        // Identity
        this.linkedId = linkedId;
        this.ani = ani;
        this.dnis = dnis;

        // Lifecycle
        this.startTime = new Date();
        this.active = true;
        this.terminated = false;

        // Silence tracking
        this.silenceCount = 0;
        this.consecutiveSilences = 0;
        this.lastVoiceDetectedAt = null;

        // HOLD state (future feature)
        this.inHold = false;
        this.holdEnteredAt = null;

        // Conversation history
        this.history = [];

        // Current phase (domain-controlled)
        this.currentPhase = null;

        // Audio state
        this.hasSpeech = false;
        this.successfulTurns = 0;
    }

    /**
     * Reset silence counters when voice is detected
     */
    resetSilence() {
        this.silenceCount = 0;
        this.consecutiveSilences = 0;
        this.lastVoiceDetectedAt = Date.now();
    }

    /**
     * Increment silence counters
     */
    incrementSilence() {
        this.silenceCount++;
        this.consecutiveSilences++;
    }

    /**
     * Mark voice as detected (resets consecutive silences)
     */
    markVoiceDetected() {
        this.consecutiveSilences = 0;
        this.lastVoiceDetectedAt = Date.now();
        this.hasSpeech = true;
    }

    /**
     * Mark session as terminated (idempotent)
     */
    terminate() {
        if (this.terminated) {
            log('debug', `[SESSION] Already terminated: ${this.linkedId}`);
            return;
        }

        this.terminated = true;
        this.active = false;
        log('info', `[SESSION] Terminated: ${this.linkedId}`);
    }

    /**
     * Add message to conversation history
     */
    addToHistory(role, content) {
        this.history.push({ role, content, timestamp: new Date() });
    }

    /**
     * Increment successful turn counter
     */
    incrementTurn() {
        this.successfulTurns++;
    }

    /**
     * Get session duration in seconds
     */
    getDurationSeconds() {
        return Math.round((new Date() - this.startTime) / 1000);
    }

    /**
     * Check if session should be considered stale
     */
    isStale(maxDurationMs = 300000) { // 5 minutes default
        return (Date.now() - this.startTime.getTime()) > maxDurationMs;
    }

    /**
     * Get session summary for logging
     */
    getSummary() {
        return {
            linkedId: this.linkedId,
            ani: this.ani,
            dnis: this.dnis,
            duration: this.getDurationSeconds(),
            turns: this.successfulTurns,
            hasSpeech: this.hasSpeech,
            currentPhase: this.currentPhase,
            terminated: this.terminated
        };
    }
}
