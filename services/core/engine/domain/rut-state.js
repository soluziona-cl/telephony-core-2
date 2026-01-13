import { log } from "../../../../lib/logger.js";
import { normalizeRut, isValidRut, maskRut, parseRutFromSpeech, cleanAsrNoise, extractRutHard } from "../utils.js";
import { classifyConfirmSimple } from "../legacy-compat/confirm-classifier.js";
import { getPatientByRut } from "../legacy-compat/db-queries.js";
import { sendBvdaText } from "../legacy/legacy-helpers.js";

function getMaskedRutReading(body, dv) {
    if (!body) return "desconocido";
    const last3 = body.toString().slice(-3);

    const digitMap = {
        '0': 'cero', '1': 'uno', '2': 'dos', '3': 'tres', '4': 'cuatro',
        '5': 'cinco', '6': 'seis', '7': 'siete', '8': 'ocho', '9': 'nueve', 'k': 'ka', 'K': 'ka'
    };

    const readDigits = (str) => str.split('').map(c => digitMap[c] || c).join(' ');

    return `${readDigits(last3)} guión ${digitMap[dv.toString().toLowerCase()] || dv}`;
}

/**
 * RUT State Machine Logic
 * Handles determination of RUT from transcript based on current phase.
 */
export async function handleRutState(transcript, businessState, linkedId, ari, channel, openaiClient) {
    const result = {
        ttsText: null,
        shouldHangup: false
    };

    const cleanTranscript = (transcript || "").toLowerCase();

    log("debug", `⚙️ [RUT LOGIC] Phase=${businessState.rutPhase} Input="${cleanTranscript}"`);

    switch (businessState.rutPhase) {

        // --- FASE 1: Esperando RUT COMPLETO (12345678-9) ---
        case 'WAIT_BODY':
        case 'WAIT_RUT':
            // 🎯 CAPA 1: Regex fuerte PRIMERO (early exit si es válido)
            const hardRut = extractRutHard(transcript);

            if (hardRut && isValidRut(hardRut)) {
                // ✅ RUT válido capturado por regex → SALIDA INMEDIATA
                const normalized = normalizeRut(hardRut);
                const body = normalized.slice(0, -1);
                const dv = normalized.slice(-1);

                businessState.rutBody = body;
                businessState.rutDv = dv;
                businessState.rutPhase = 'CONFIRM';
                businessState.rutAttempts = 0;
                businessState.confirmAttempts = 0;

                const maskedReading = getMaskedRutReading(body, dv);
                result.ttsText = `Tengo registrado el RUT terminado en ${maskedReading}. ¿Es correcto?`;
                log("info", `✅ [STATE] RUT capturado por regex duro: ${normalized} (Input: "${transcript}")`);
                break;
            }

            // 🎯 CAPA 2: Parser mejorado con normalización y regex robusto
            const parsed = parseRutFromSpeech(cleanTranscript);

            log("debug", `⚙️ [RUT PARSER] reason=${parsed.reason} body=${parsed.body} dv=${parsed.dv} ok=${parsed.ok}`);

            // Si detectamos BODY + DV juntos → saltar directamente a CONFIRM
            if (parsed.body && parsed.dv) {
                const bodyStr = String(parsed.body);
                const isValid = isValidRut(normalizeRut(`${bodyStr}${parsed.dv}`));

                businessState.rutBody = bodyStr;
                businessState.rutDv = parsed.dv;
                businessState.rutPhase = 'CONFIRM';
                businessState.rutAttempts = 0;
                businessState.confirmAttempts = 0;

                const maskedReading = getMaskedRutReading(bodyStr, parsed.dv);
                result.ttsText = isValid
                    ? `Tengo registrado el RUT terminado en ${maskedReading}. ¿Es correcto?`
                    : `Escuché el RUT terminado en ${maskedReading}. ¿Es correcto?`;

                log("info", `✅ [STATE] BODY+DV capturados juntos: Body=${bodyStr} DV=${parsed.dv} (Input: "${transcript}")`);
                break;
            }

            // Si solo tenemos BODY → pasar a WAIT_DV
            if (parsed.body && !parsed.dv) {
                const bodyStr = String(parsed.body);
                businessState.rutBody = bodyStr;
                businessState.rutPhase = 'WAIT_DV';
                businessState.rutAttempts++;
                log("info", `📝 [STATE] Body capturado: ${bodyStr}. Esperando DV. Intento #${businessState.rutAttempts}`);
                result.ttsText = "Me faltó el dígito verificador. Por favor dígame solo el dígito verificador, por ejemplo: guión ocho, o guión k.";
                break;
            }

            // No se entendió nada → incrementar intentos
            businessState.rutAttempts++;
            log("warn", `⚠️ [STATE] No entendí RUT. Intento #${businessState.rutAttempts}`);

            if (businessState.rutAttempts >= 3) {
                businessState.rutPhase = 'FAILED';
                result.ttsText = "No logro capturar su RUT. Le transferiré con un ejecutivo.";
                result.shouldHangup = true;
            } else {
                result.ttsText = "Por favor, indíqueme su RUT completo, incluyendo el dígito verificador.";
            }
            break;

        // --- FASE 2: Esperando solo DV ---
        case 'WAIT_DV':
            // Limpiar ruido social primero (BUENAS NOCHES, etc.)
            const cleanedDV = cleanAsrNoise(transcript);

            // Si después de limpiar solo queda ruido, ignorar y seguir pidiendo
            if (!cleanedDV || cleanedDV.trim().length === 0 || /^(Y|Y\s+BUENAS|BUENAS|NOCHE|HOLA)$/i.test(cleanedDV.trim())) {
                businessState.rutAttempts++;
                log("info", `🔇 [STATE] Ruido social ignorado en WAIT_DV: "${transcript}". Intento #${businessState.rutAttempts}`);

                if (businessState.rutAttempts >= 3) {
                    businessState.rutPhase = 'FAILED';
                    result.ttsText = "No logro capturar el dígito verificador. Le transferiré con un ejecutivo.";
                    result.shouldHangup = true;
                } else {
                    result.ttsText = "Solo necesito el dígito verificador, por ejemplo: ocho o K.";
                }
                break;
            }

            // Intentar extraer DV con regex primero
            const dvMatch = cleanedDV.match(/([0-9K])/);
            if (dvMatch) {
                const dv = dvMatch[1].toUpperCase();
                businessState.rutDv = dv;
                const rawRut = `${businessState.rutBody}-${dv}`;
                const normalized = normalizeRut(rawRut);

                if (isValidRut(normalized)) {
                    businessState.rutPhase = 'CONFIRM';
                    businessState.rutAttempts = 0;
                    businessState.confirmAttempts = 0; // Inicializar contador de confirmación
                    const maskedReading = getMaskedRutReading(businessState.rutBody, dv);
                    result.ttsText = `Tengo registrado el RUT terminado en ${maskedReading}. ¿Es correcto?`;
                    log("info", `✅ [STATE] WAIT_DV -> CONFIRM (RUT=${normalized})`);
                    break;
                } else {
                    // ✅ CONFIRMACIÓN INTELIGENTE: Si el DV no calza, confirmar en lugar de rechazar
                    businessState.rutPhase = 'CONFIRM';
                    businessState.rutAttempts = 0;
                    businessState.confirmAttempts = 0; // Inicializar contador de confirmación
                    const maskedReading = getMaskedRutReading(businessState.rutBody, dv);
                    result.ttsText = `Escuché el RUT terminado en ${maskedReading}. ¿Es correcto?`;
                    log("warn", `⚠️ [STATE] DV no calza matemáticamente pero pedimos confirmación. Body=${businessState.rutBody} DV=${dv}`);
                    break;
                }
            }

            // Si regex falló, intentar NLP semántico
            const parsedDV = parseRutFromSpeech(cleanTranscript);

            if (parsedDV.dv) {
                // DV capturado
                businessState.rutDv = parsedDV.dv;
                const rawRut = `${businessState.rutBody}-${businessState.rutDv}`;
                const normalized = normalizeRut(rawRut);

                if (isValidRut(normalized)) {
                    businessState.rutPhase = 'CONFIRM';
                    businessState.rutAttempts = 0;
                    businessState.confirmAttempts = 0; // Inicializar contador de confirmación
                    const maskedReading = getMaskedRutReading(businessState.rutBody, businessState.rutDv);
                    result.ttsText = `Tengo registrado el RUT terminado en ${maskedReading}. ¿Es correcto?`;
                    log("info", `✅ [STATE] WAIT_DV -> CONFIRM (RUT=${normalized})`);
                } else {
                    // ✅ CONFIRMACIÓN INTELIGENTE: Si el DV no calza, confirmar en lugar de rechazar
                    businessState.rutPhase = 'CONFIRM';
                    businessState.rutAttempts = 0;
                    businessState.confirmAttempts = 0; // Inicializar contador de confirmación
                    const maskedReading = getMaskedRutReading(businessState.rutBody, businessState.rutDv);
                    result.ttsText = `Escuché el RUT terminado en ${maskedReading}. ¿Es correcto?`;
                    log("warn", `⚠️ [STATE] DV no calza matemáticamente pero pedimos confirmación. Body=${businessState.rutBody} DV=${businessState.rutDv}`);
                }
            } else {
                businessState.rutAttempts++;
                log("warn", `⚠️ [STATE] No se capturó DV. Intento #${businessState.rutAttempts}`);

                if (businessState.rutAttempts >= 3) {
                    businessState.rutPhase = 'FAILED';
                    result.ttsText = "No logro capturar el dígito verificador. Le transferiré con un ejecutivo.";
                    result.shouldHangup = true;
                } else {
                    result.ttsText = "Por favor dígame solo el dígito verificador, por ejemplo: guión ocho, o guión k.";
                }
            }
            break;

        // --- FASE 2: Confirmación (Sí/No) con CLASIFICADOR ROBUSTO ---
        case 'CONFIRM':
            // Inicializar contador de confirmación si no existe
            if (businessState.confirmAttempts === undefined) {
                businessState.confirmAttempts = 0;
            }
            businessState.confirmAttempts++;

            // 0. Verificar si el usuario corrigió solo el DV (mantiene body, cambia DV)
            const parsedCorrection = parseRutFromSpeech(cleanTranscript);
            if (parsedCorrection.dv && parsedCorrection.dv !== businessState.rutDv &&
                (!parsedCorrection.body || parsedCorrection.body === businessState.rutBody)) {
                // Usuario corrigió solo el DV
                log("info", `🔄 [STATE] Usuario corrigió DV: ${businessState.rutDv} -> ${parsedCorrection.dv}`);
                businessState.rutDv = parsedCorrection.dv;
                businessState.confirmAttempts = 0; // Reset contador al corregir
                const rawRutCorrected = `${businessState.rutBody}-${businessState.rutDv}`;
                const normalizedCorrected = normalizeRut(rawRutCorrected);

                if (isValidRut(normalizedCorrected)) {
                    const maskedReading = getMaskedRutReading(businessState.rutBody, businessState.rutDv);
                    result.ttsText = `Entendido. Entonces el RUT termina en ${maskedReading}. ¿Es correcto?`;
                    break;
                } else {
                    result.ttsText = `Escuché una corrección, pero el dígito ${parsedCorrection.dv} no parece ser válido para este RUT. ¿Es el dígito verificador K?`;
                    break;
                }
            }

            // 1. Clasificador Sí/No
            const isConfirmed = classifyConfirmSimple(cleanTranscript);

            if (isConfirmed === true) {
                // ✅ CONFIRMADO
                const fullRut = `${businessState.rutBody}${businessState.rutDv}`;
                const normalized = normalizeRut(fullRut);

                if (isValidRut(normalized)) {
                    log("info", `✅ [STATE] CONFIRM -> COMPLETE (RUT Validado: ${normalized})`);
                    businessState.dni = normalized;
                    businessState.rutPhase = 'COMPLETE';
                    businessState.rutAttempts = 0; // Reset intentos para la siguiente lógica
                    result.ttsText = null; // No TTS, dejar que el motor avance a BDD

                    // Búsqueda en DB (Mensaje BVDA - Protegido)
                    // Note: This was partly in voice-engine.js legacy fallback, integrating here for completeness if needed?
                    // Actually, the original handleRutState did NOT do the DB lookup inside the Confirm block, it returned and then voice-engine did it?
                    // Let's check original logic.
                    // Original legacy-business.js handleRutState stopped at "result.ttsText = null".
                    // The "FASE C: Validación y Búsqueda" block in voice-engine.js (lines ~900 in original) handled the DB lookup?
                    // No, handleRutState is used by StrictModeOrchestrator.
                    // StrictModeOrchestrator DOES logic after execution.
                    // But wait, StrictModeOrchestrator calls handleRutState.
                    // Does StrictModeOrchestrator handle the DB lookup?
                    // Let's check strict-mode.js.

                    // If logic is here, we should do it here if possible, but handleRutState is pure state update.
                    // The original handleRutState (Step 740) did NOT have DB lookup in 'CONFIRM' case.
                    // It just set Phase to COMPLETE.

                } else {
                    log("warn", `❌ [STATE] CONFIRM -> ERROR. Usuario confirmó RUT inválido matemáticamente.`);
                    businessState.rutPhase = 'WAIT_BODY'; // Reiniciar
                    businessState.rutBody = null;
                    businessState.rutDv = null;
                    businessState.rutAttempts = 0;
                    result.ttsText = "Al verificar el RUT, hay un error matemático. Por favor indíqueme el RUT nuevamente desde el principio.";
                }
            } else if (isConfirmed === false) {
                // ❌ RECHAZADO
                log("info", `🔄 [STATE] Usuario rechazó RUT. Reiniciando captura.`);
                businessState.rutPhase = 'WAIT_BODY';
                businessState.rutBody = null;
                businessState.rutDv = null;
                businessState.rutAttempts = 0;
                result.ttsText = "Entendido, empecemos de nuevo. Por favor dígame su RUT.";
            } else {
                // ❓ AMBIGUO
                log("warn", `⚠️ [STATE] Confirmación ambigua: "${transcript}"`);
                if (businessState.confirmAttempts >= 2) {
                    // Si es ambiguo 2 veces, asumir rechazo y pedir de nuevo
                    log("warn", `⚠️ [STATE] Demasiada ambigüedad. Reiniciando por seguridad.`);
                    businessState.rutPhase = 'WAIT_BODY';
                    businessState.rutBody = null;
                    businessState.rutDv = null;
                    businessState.rutAttempts = 0;
                    result.ttsText = "No logré captar la confirmación. Por favor, dígame su RUT completo nuevamente para estar seguros.";
                } else {
                    // Repreguntar
                    result.ttsText = "No entendí si es correcto o no. Por favor diga Sí o No.";
                }
            }
            break;

        default:
            log("warn", `⚠️ [STATE] Fase desconocida: ${businessState.rutPhase}`);
            break;
    }
    return result;
}
