/**
 * ENGINE GUARDRAILS
 * Defensive logic to prevent hallucinations, loops, and invalid states.
 */

import { log } from "../../../../lib/logger.js";

export const Guardrails = {
    /**
     * Prevents repeating the exact same text specifically in Strict Mode.
     */
    shouldBlockReplay(lastText, newText) {
        if (!lastText || !newText) return false;
        // Simple exact match for now
        if (lastText === newText) {
            log("warn", `🔇 [GUARDRAIL] Anti-Replay triggered for: "${newText.slice(0, 30)}..."`);
            return true;
        }
        return false;
    },

    /**
     * Prevents fallback to OpenAI (hallucination risk) if we lost identity context
     * in deep turns. 
     * Rule 2.3: "Si no sé quién eres y ya llevamos rato hablando, corto."
     */
    shouldBlockFallback(turn, rutFormatted, currentPhase) {
        // Si estamos en turnos avanzados (>1) y aun no tenemos RUT validado, 
        // y NO estamos esperando el cuerpo del RUT (que sería normal),
        // entonces algo anda mal.
        if (turn > 1 && !rutFormatted && currentPhase !== 'WAIT_BODY') {
            log("warn", "[GUARDRAIL] Anti-Hallucination: Fallback blocked (Deep turn without Identity).");
            return true;
        }
        return false;
    },

    /**
     * Prevents a "COMPLETE" state without having actually captured the RUT.
     * This happens if logic jumps to complete prematurely.
     */
    shouldBlockInvalidComplete(rutPhase, rutFormatted) {
        if (rutPhase === 'COMPLETE' && !rutFormatted) {
            log("warn", "[GUARDRAIL] Invalid State: Session COMPLETE without valid RUT.");
            return true;
        }
        return false;
    }
};
