import {
    parseRutFromSpeech,
    normalizeRut,
    isValidRut
} from '../../core/engine/utils.js';

export function parseAndValidateRut(transcript) {
    const parsed = parseRutFromSpeech(transcript);
    if (!parsed) return { valid: false };

    const normalized = normalizeRut(parsed);
    if (!isValidRut(normalized)) return { valid: false };

    return {
        valid: true,
        rut: normalized
    };
}
