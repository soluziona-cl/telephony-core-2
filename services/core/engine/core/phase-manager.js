/**
 * PhaseManager - Manages voice engine phases and state transitions
 * 
 * Purpose: Centralize phase transition logic, ensuring consistent logging
 * and state updates. Isolate "magic string" phase manipulations.
 * 
 * Governance: CORE module - no client-specific logic
 */

import { log } from '../../../../lib/logger.js';

export class PhaseManager {
    constructor(phasesConfig = {}, logger = null) {
        this.PHASES = phasesConfig;
        this.logger = logger || {
            info: (msg) => log('info', `[PHASE] ${msg}`),
            warn: (msg) => log('warn', `[PHASE] ⚠️ ${msg}`)
        };
    }

    /**
     * Transition session to a new phase
     * @param {Object} session - SessionContext instance
     * @param {string} nextPhase - Target phase name
     * @param {Object} metadata - Optional metadata (reason, source, etc.)
     * @returns {boolean} - true if transition occurred, false if already in phase
     */
    transition(session, nextPhase, metadata = {}) {
        if (!nextPhase) return false;

        const currentPhase = session.currentPhase;

        if (currentPhase === nextPhase) {
            return false; // No change
        }

        // Validate phase exists in config (optional warning)
        if (this.PHASES && !this.PHASES[nextPhase]) {
            this.logger.warn(`Transitioning to undefined phase: ${nextPhase}`);
        }

        this.logger.info(`🔀 Transition: ${currentPhase} -> ${nextPhase} ${metadata.reason ? `(${metadata.reason})` : ''}`);

        // Update session state
        session.currentPhase = nextPhase;

        return true;
    }

    /**
     * Check if a phase requires user input
     * @param {string} phaseName 
     * @returns {boolean}
     */
    requiresInput(phaseName) {
        const phase = this.PHASES[phaseName];
        // Default to false (silent) if phase not defined, to trigger silence policy/hold
        return phase ? !!phase.requiresInput : false;
    }

    /**
     * Check if a phase is considered "silent" (no user input expected)
     * @param {string} phaseName 
     * @returns {boolean}
     */
    isSilentPhase(phaseName) {
        return !this.requiresInput(phaseName);
    }

    /**
     * Reset session state for a specific phase (if needed)
     * This is a placeholder for future state cleanup logic
     * @param {Object} session 
     */
    resetForPhase(session) {
        // Check if current phase requires resetting any counters
        // Currently most resets happen in domain logic or specific policies
        // This provides a hook for future expansion
    }
}
