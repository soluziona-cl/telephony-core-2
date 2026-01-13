// =========================================================
// DOMAIN CONTRACT — OBLIGATORIO PARA CUALQUIER BOT
// =========================================================

/**
 * @typedef {Object} DomainContext
 * @property {string} transcript
 * @property {string} sessionId
 * @property {string} ani
 * @property {string} dnis
 * @property {Object} state
 * @property {Object} ari
 * @property {Object} channel
 */

/**
 * @typedef {Object} DomainResult
 * @property {string=} ttsText        // Texto a decir (TTS)
 * @property {string=} soundFile      // sound:voicebot/xxx
 * @property {string=} nextPhase
 * @property {boolean=} shouldHangup
 */

/**
 * CONTRATO DURO:
 * - El dominio decide TODO
 * - El engine NO valida lógica
 * - El dominio DEBE controlar loops
 */

/**
 * Ejemplo base de dominio robusto
 */
export function createDomain() {
    const state = {
        phase: "START",
        noInputCount: 0,
        attempts: 0
    };

    async function domain(ctx) {
        // SILENCIO
        if (!ctx.transcript || ctx.transcript.trim() === "") {
            state.noInputCount++;

            if (state.noInputCount === 1) {
                return { ttsText: "No te escuché bien, ¿puedes repetir?" };
            }

            if (state.noInputCount === 2) {
                return { ttsText: "Sigo sin escucharte, intenta hablar más fuerte." };
            }

            return {
                ttsText: "No pude escucharte. Te llamaremos más tarde.",
                shouldHangup: true
            };
        }

        // INPUT VÁLIDO
        state.noInputCount = 0;

        // EJEMPLO DE FLUJO
        if (state.phase === "START") {
            state.phase = "WAIT_DATA";
            return {
                ttsText: "Por favor dime tu número de identificación."
            };
        }

        if (state.phase === "WAIT_DATA") {
            state.attempts++;

            if (state.attempts >= 3) {
                return {
                    ttsText: "No pudimos validar la información. Te llamaremos más tarde.",
                    shouldHangup: true
                };
            }

            // Validación ficticia
            if (ctx.transcript.length < 5) {
                return {
                    ttsText: "El dato no es válido, repítelo por favor."
                };
            }

            return {
                ttsText: "Gracias, hemos registrado la información.",
                shouldHangup: true
            };
        }

        return {
            ttsText: "Ocurrió un error inesperado.",
            shouldHangup: true
        };
    }

    return {
        domain,
        state,
        systemPrompt: `
Eres un asistente telefónico.
Responde de forma breve y clara.
Nunca inventes datos.
`
    };
}
