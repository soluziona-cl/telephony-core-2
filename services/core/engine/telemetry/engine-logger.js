/**
 * EngineLogger - Standardized Telemetry & Logging for Voice Engine
 * 
 * Purpose: Centralize logging logic, enforce structured formats, and 
 * automatically inject session context into every log entry.
 * 
 * Governance: CORE module - no client-specific logic
 */

import { log } from '../../../../lib/logger.js';

export class EngineLogger {
    constructor(session) {
        this.session = session;
        this.prefix = `[ENGINE] [${session.linkedId.substring(0, 8)}]`;
    }

    /**
     * Log information with session context
     * @param {string} message 
     */
    info(message) {
        log('info', `${this.prefix} ${message}`);
    }

    /**
     * Log warning with session context
     * @param {string} message 
     */
    warn(message) {
        log('warn', `${this.prefix} ⚠️ ${message}`);
    }

    /**
     * Log error with session context
     * @param {string} message 
     */
    error(message) {
        log('error', `${this.prefix} ❌ ${message}`);
    }

    /**
     * Log debug info (verbose)
     * @param {string} message 
     */
    debug(message) {
        log('debug', `${this.prefix} 🐛 ${message}`);
    }

    /**
     * Log turn start
     * @param {number} turnNumber 
     */
    logTurn(turnNumber) {
        this.info(`🔄 Turn #${turnNumber} started`);
    }

    /**
     * Log phase transition
     * @param {string} fromPhase 
     * @param {string} toPhase 
     */
    logPhaseTransition(fromPhase, toPhase) {
        if (fromPhase !== toPhase) {
            this.info(`🔀 Phase Change: ${fromPhase} -> ${toPhase}`);
        }
    }

    /**
     * Log silence detection event
     * @param {number} count - Current silence count
     * @param {number} max - Max allowed silences
     */
    logSilence(count, max) {
        this.warn(`😶 Silence detected (${count}/${max})`);
    }

    /**
     * Log HOLD state change
     * @param {boolean} inHold 
     * @param {string} reason 
     */
    logHold(inHold, reason = '') {
        const icon = inHold ? '🎵' : '🗣️';
        const action = inHold ? 'ENTERED HOLD' : 'EXITED HOLD';
        this.info(`${icon} ${action} ${reason ? `(${reason})` : ''}`);
    }

    /**
     * Log session termination
     * @param {string} reason 
     */
    logTermination(reason) {
        this.info(`🔚 Session terminated: ${reason}`);
    }

    /**
     * Log module activity
     * @param {string} module - Module name (e.g. ARI, POLICIES)
     * @param {string} message 
     */
    logModule(module, message) {
        log('info', `${this.prefix} [${module}] ${message}`);
    }
}
