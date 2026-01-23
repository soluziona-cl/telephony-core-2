/**
 * 📄 STTResult Interface (Source of Truth)
 * 
 * Defines the contract for STT results delivered to the domain.
 * The domain must handle this payload type via onUserInput.
 * 
 * @typedef {Object} STTResult
 * @property {string} text - The transcribed text (or empty string if silence)
 * @property {number} [confidence] - Confidence score (0-1) if available
 * @property {number} latencyMs - End-to-end latency in milliseconds
 * @property {string} audioFile - Path to the recorded audio file (batch mode)
 * @property {number} silenceMs - Detected silence duration before processing
 */

export const STT_CONTRACT = {
    type: 'STT',
    payload: {
        text: 'string',
        confidence: 'number?',
        latencyMs: 'number',
        audioFile: 'string',
        silenceMs: 'number'
    }
};
