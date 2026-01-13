/**
 * RecordingModule - Manages audio recording operations
 * 
 * Purpose: Isolate all recording logic including validation,
 * timeout handling, and file management.
 * 
 * Governance: CORE module - no client-specific logic
 */

import fs from 'fs';
import { log } from '../../../../lib/logger.js';

export class RecordingModule {
    constructor(config = {}) {
        this.maxRecordingMs = config.maxRecordingMs || 15000;
        this.silenceThresholdSec = config.maxSilenceSeconds || 2;
        this.silenceThreshold = config.silenceThreshold || 2500;
        this.minWavSizeBytes = config.minWavSizeBytes || 6000;
        this.recordingsPath = config.recordingsPath || '/var/spool/asterisk/recording';
    }

    /**
     * Record user turn
     * 
     * @param {Object} channel - ARI channel
     * @param {number} turnNumber - Current turn number
     * @returns {Promise<Object>} - { ok, reason, path?, recId?, duration? }
     */
    async recordUserTurn(channel, turnNumber) {
        const recId = `vb_${Date.now()}`;
        const wavFile = `${this.recordingsPath}/${recId}.wav`;

        log('info', `🎙️ [RECORDING] Starting turn #${turnNumber}: ${recId}`);

        let recordingObj;
        try {
            recordingObj = await channel.record({
                name: recId,
                format: 'wav',
                beep: false,
                maxSilenceSeconds: this.silenceThresholdSec,
                silenceThreshold: this.silenceThreshold,
                ifExists: 'overwrite'
            });
        } catch (err) {
            log('error', `❌ [RECORDING] Failed to start: ${err.message}`);
            return { ok: false, reason: 'record-start-failed' };
        }

        const startedAt = Date.now();

        const result = await new Promise((resolve) => {
            let finished = false;

            const cleanup = () => {
                if (finished) return;
                finished = true;
                recordingObj.removeAllListeners('RecordingFinished');
                recordingObj.removeAllListeners('RecordingFailed');
            };

            recordingObj.on('RecordingFinished', () => {
                if (finished) return;
                const duration = ((Date.now() - startedAt) / 1000).toFixed(2);
                log('info', `🎙️ [RECORDING] Finished: ${recId}.wav (${duration}s)`);
                cleanup();
                resolve({ ok: true, reason: 'finished', duration });
            });

            recordingObj.on('RecordingFailed', (evt) => {
                if (finished) return;
                log('error', `❌ [RECORDING] Failed: ${JSON.stringify(evt)}`);
                cleanup();
                resolve({ ok: false, reason: 'record-failed' });
            });

            // Timeout protection
            const timer = setInterval(() => {
                if (finished) {
                    clearInterval(timer);
                    return;
                }
                if (Date.now() - startedAt > this.maxRecordingMs) {
                    log('warn', `⏰ [RECORDING] Timeout: ${recId}`);
                    try {
                        recordingObj
                            .stop()
                            .catch((err) => log('warn', `⚠️ [RECORDING] Error on timeout: ${err.message}`));
                    } catch (err) {
                        log('warn', `⚠️ [RECORDING] Exception on timeout: ${err.message}`);
                    }
                    clearInterval(timer);
                }
            }, 500);
        });

        // Wait for file to exist
        const exists = await this.waitForFile(wavFile, 3000, 100);
        if (!exists) {
            log('error', `❌ [RECORDING] File not found: ${wavFile}`);
            return { ok: false, reason: 'file-not-found' };
        }

        // Validate recording
        if (!this.isValidRecording(wavFile)) {
            return { ok: false, reason: 'silence', path: wavFile };
        }

        log('info', `✅ [RECORDING] Valid: ${wavFile} (${result.duration}s)`);
        return { ok: true, reason: 'ok', path: wavFile, recId, duration: result.duration };
    }

    /**
     * Wait for file to exist
     * 
     * @param {string} path
     * @param {number} timeoutMs
     * @param {number} intervalMs
     * @returns {Promise<boolean>}
     */
    async waitForFile(path, timeoutMs = 3000, intervalMs = 100) {
        const start = Date.now();

        return new Promise((resolve) => {
            const timer = setInterval(() => {
                try {
                    if (fs.existsSync(path)) {
                        const stats = fs.statSync(path);
                        if (stats.size > 0) {
                            clearInterval(timer);
                            log('debug', `✅ [FILE] Found: ${path} (${stats.size} bytes)`);
                            return resolve(true);
                        }
                    }

                    if (Date.now() - start > timeoutMs) {
                        clearInterval(timer);
                        log('warn', `⏱️ [FILE] Timeout waiting for: ${path}`);
                        return resolve(false);
                    }
                } catch (err) {
                    log('debug', `[FILE] Error checking: ${err.message}`);
                }
            }, intervalMs);
        });
    }

    /**
     * Validate recording file
     * 
     * @param {string} path
     * @returns {boolean}
     */
    isValidRecording(path) {
        try {
            if (!fs.existsSync(path)) {
                log('warn', `❌ [VALIDATION] File does not exist: ${path}`);
                return false;
            }

            const stats = fs.statSync(path);

            // CRITICAL FILTER: Ignore audio smaller than minWavSizeBytes (WebRTC noise / micro-turns)
            if (stats.size < this.minWavSizeBytes) {
                log('warn', `🤫 [VALIDATION] Audio too small (${stats.size} bytes < ${this.minWavSizeBytes}), ignoring`);
                return false;
            }

            log('debug', `📁 [VALIDATION] Recording size: ${stats.size} bytes`);
            return true;
        } catch (err) {
            log('error', `❌ [VALIDATION] Error: ${err.message}`);
            return false;
        }
    }
}
