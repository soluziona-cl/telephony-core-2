/**
 * 🤖 Bot Upcom Toma Datos
 * Recopila Nombre, RUT y Teléfono, envía webhook y despide.
 */

import { log } from '../../../../lib/logger.js';

// Estado inicial
function initialState() {
    return {
        step: 'ASK_NAME', // ASK_NAME, ASK_RUT, ASK_PHONE, END
        data: {
            name: null,
            rut: null,
            phone: null
        },
        attempts: 0
    };
}

// Mensajes (Hardcoded por ahora para simplificar, idealmente en archivo separado)
const MESSAGES = {
    askRut: "Gracias. Ahora, por favor indíqueme su RUT.",
    askPhone: "Bien. Por último, indíqueme su número de teléfono de contacto.",
    goodbye: "Perfecto, hemos registrado sus datos. Nos pondremos en contacto con usted a la brevedad. Adiós.",
    fallback: "No le he entendido bien. ¿Podría repetirlo?",
    error: "Ha ocurrido un error. Cortaremos la llamada. Gracias."
};

/**
 * Entry Point del Dominio
 */
export default async function upcomTomadatosBot(ctx) {
    // 1. Inicializar estado
    if (!ctx.state) {
        ctx.state = initialState();
        log("info", "🆕 [UPCOM] Estado inicializado");
    }

    const { state, transcript } = ctx;
    const cleanTranscript = transcript ? transcript.trim() : "";

    log("debug", `🔄 [UPCOM] Fase: ${state.step}, Input: "${cleanTranscript}"`);

    // Si no hay input y no es el inicio (aunque el engine suele filtrar esto), retornar espera
    // Pero si acabamos de inicializar, asumimos que estamos esperando input tras el saludo inicial
    if (!cleanTranscript && state.step !== 'END') {
        // Si es el primer turno y no hay input, el engine ya reprodujo el saludo.
        // Mantenemos silencio esperando input.
        return {
            ttsText: null,
            nextPhase: state.step,
            shouldHangup: false
        };
    }

    let nextPhase = state.step;
    let ttsText = null;
    let shouldHangup = false;
    let action = null;

    switch (state.step) {
        case 'ASK_NAME':
            if (cleanTranscript) {
                state.data.name = cleanTranscript;
                log("info", `✅ [UPCOM] Nombre capturado: ${cleanTranscript}`);

                nextPhase = 'ASK_RUT';
                ttsText = MESSAGES.askRut;

                // Reset de intentos para la nueva fase (si los usaramos)
                state.attempts = 0;
            } else {
                // Should not happen due to guard above, but handle retry logic if needed
                ttsText = MESSAGES.fallback;
            }
            break;

        case 'ASK_RUT':
            if (cleanTranscript) {
                state.data.rut = cleanTranscript;
                log("info", `✅ [UPCOM] RUT capturado: ${cleanTranscript}`);

                nextPhase = 'ASK_PHONE';
                ttsText = MESSAGES.askPhone;
                state.attempts = 0;
            } else {
                ttsText = MESSAGES.fallback;
            }
            break;

        case 'ASK_PHONE':
            if (cleanTranscript) {
                state.data.phone = cleanTranscript;
                log("info", `✅ [UPCOM] Teléfono capturado: ${cleanTranscript}`);

                // Enviar Webhook (Simulado)
                await sendWebhook(state.data);

                nextPhase = 'END';
                ttsText = MESSAGES.goodbye;
                shouldHangup = true;
                action = {
                    type: "END_CALL",
                    payload: { reason: "COMPLETED", data: state.data }
                };
            } else {
                ttsText = MESSAGES.fallback;
            }
            break;

        case 'END':
            shouldHangup = true;
            break;

        default:
            log("error", `❌ [UPCOM] Fase desconocida: ${state.step}`);
            ttsText = MESSAGES.error;
            shouldHangup = true;
            break;
    }

    // Actualizar estado para la próxima iteración
    state.step = nextPhase;

    return {
        ttsText,
        nextPhase,
        shouldHangup,
        action,
        // Persistir estado actualizado en ctx (engine lo guarda)
        state: state
    };
}

// Simulacion de Webhook
async function sendWebhook(data) {
    log("info", `📡 [WEBHOOK] Enviando datos (SIMULADO): ${JSON.stringify(data)}`);
    // Aquí iría la llamada real con axios/fetch
    // const response = await fetch('URL', { method: 'POST', body: JSON.stringify(data) });
    return true;
}

// Exportar saludo inicial por si el engine lo pide
// Pero usaremos 'greetingFile' en config
export function getGreeting() {
    // Este texto debería coincidir con el audio generado
    return "Hola, gracias por llamar. Para comenzar, por favor indíqueme su nombre completo.";
}
