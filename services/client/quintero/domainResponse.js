/**
 * 🔒 Domain Governance - Response Contract Enforcer
 * Validates that the Domain always implements the strict DomainResponse contract.
 */

/**
 * Normalizes a potentially partial response into a strict DomainResponse.
 * @param {object} resp - The response from the domain/bot logic.
 * @param {string} fallbackPhase - Current phase to fallback if nextPhase is missing.
 * @returns {object} - Strict DomainResponse
 */
export function normalizeDomainResponse(resp, fallbackPhase) {
    const r = resp || {};
    return {
        nextPhase: r.nextPhase ?? fallbackPhase ?? 'WAIT_BODY',
        ttsText: (typeof r.ttsText === 'string') ? r.ttsText : null,
        audio: (typeof r.audio === 'string') ? r.audio : null,
        silent: typeof r.silent === 'boolean' ? r.silent : false,
        skipUserInput: typeof r.skipUserInput === 'boolean' ? r.skipUserInput : false,
        action: r.action ?? { type: 'SET_STATE' }, // Default action is safe state update or no-op
        statePatch: r.statePatch ?? null,
        // 🎯 CONTRATO INCREMENTAL: Preservar flags del dominio
        enableIncremental: r.enableIncremental,
        disableIncremental: r.disableIncremental,
    };
}

/**
 * Validates the response against the contract.
 * @param {object} resp - Normalized response.
 * @returns {string[]} - List of error codes, or empty if valid.
 */
export function assertDomainResponse(resp) {
    const errors = [];
    if (!resp || typeof resp !== 'object') errors.push('resp_not_object');
    if (!resp.nextPhase || typeof resp.nextPhase !== 'string') errors.push('nextPhase_missing');
    if (!('silent' in resp) || typeof resp.silent !== 'boolean') errors.push('silent_missing_or_invalid');
    if (!('skipUserInput' in resp) || typeof resp.skipUserInput !== 'boolean') errors.push('skipUserInput_missing_or_invalid');

    // Action can be an object with { type: string } or just a string in some legacy patterns, 
    // but strictly it should be an object or normalized to one. 
    // However, the engine usually expects { type: ... }. The normalization above sets a default object.
    // We check if it has a type if it is an object.
    if (!resp.action || (typeof resp.action === 'object' && !resp.action.type)) errors.push('action_type_missing');

    // ttsText must be string or null
    if (!(resp.ttsText === null || typeof resp.ttsText === 'string')) errors.push('ttsText_invalid');

    // audio must be string or null/undefined
    if (resp.audio !== undefined && resp.audio !== null && typeof resp.audio !== 'string') errors.push('audio_invalid');

    return errors;
}
