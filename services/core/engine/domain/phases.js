/**
 * DOMAIN MODEL: PHASES
 * Defines the valid phases of the conversation and their requirements.
 * This effectively acts as the "Heat Map" for the engine's state machine.
 */

export const PHASES = {
    // Fases de Captura (Requieren Input Obligatorio)
    'WAIT_BODY': { requiresInput: true },
    'WAIT_DV': { requiresInput: true },
    'CONFIRM': { requiresInput: true },
    'ASK_SPECIALTY': { requiresInput: true },
    'PARSE_SPECIALTY': { requiresInput: true }, // A veces es interna, pero si falló requiere input
    'CONFIRM_APPOINTMENT': { requiresInput: true },

    // Fases Informativas / Procesamiento (No requieren Input - Silenciosas)
    'CHECK_AVAILABILITY': { requiresInput: false },
    'INFORM_AVAILABILITY': { requiresInput: false },
    'FINALIZE': { requiresInput: false },
    'COMPLETE': { requiresInput: false },
    'GOODBYE': { requiresInput: false, kind: 'SPEAK' },      // Nueva fase explícita
    'NONE': { requiresInput: true, kind: 'LISTEN' },          // Fase inicial / abierta

    // 🧠 RUT FLOW (STRICT MODE COMPLIANT)
    'START_GREETING': { requiresInput: false, kind: 'SPEAK' },
    'ASK_RUT': { requiresInput: false, kind: 'SPEAK' },
    'ASK_RUT_RETRY': { requiresInput: false, kind: 'SPEAK' },
    'LISTEN_RUT': { requiresInput: true, kind: 'LISTEN' },
    'PROCESS_RUT': { requiresInput: false, kind: 'VALIDATE' },
    'HANDLE_FORMAT_RUT': { requiresInput: false, kind: 'VALIDATE' },
    'HANDLE_VALIDATE_PATIENT': { requiresInput: false, kind: 'VALIDATE' },
    'WAIT_RUT_INPUT': { requiresInput: true, kind: 'LISTEN' } // Legacy support
};

/**
 * Helper to determine if a phase is silent (does not require user input).
 * Used by SilencePolicy and HoldPolicy.
 */
export function isSilentPhase(phase) {
    if (!phase || !PHASES[phase]) return false;
    return !PHASES[phase].requiresInput;
}
