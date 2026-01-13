import { RUT_PHASES } from './rut.phases.js';
import { flowTrace } from '../../core/telemetry/flow-trace.js';

export async function runRutDomain(ctx) {
    const { transcript, state, event, webhookData } = ctx;

    flowTrace({
        traceId: ctx.sessionId,
        layer: 'DOMAIN',
        flow: 'RUT',
        step: state.rutPhase,
        depth: 2,
        module: 'domains/rut/rut.domain.js',
        fn: 'runRutDomain',
        action: 'PROCESS_TURN',
        result: 'RECV'
    });

    switch (state.rutPhase) {
        // ----------------------------------------------------------------
        // 1️⃣ INICIO: Reproducir Audio de Petición (Sin escucha)
        // ----------------------------------------------------------------
        case RUT_PHASES.INIT:
            return {
                audio: 'quintero/ask_rut',
                ttsText: null,
                nextPhase: RUT_PHASES.LISTEN_RUT,
                action: 'PLAY_AUDIO',
                silent: true,
                allowBargeIn: false
            };

        // ----------------------------------------------------------------
        // 2️⃣ ESCUCHA: Activar micrófono (Sin audio)
        // ----------------------------------------------------------------
        case RUT_PHASES.LISTEN_RUT:
            // This phase ONLY listens. 
            // It transitions to PROCESS_RUT to handle the result in the next turn.
            return {
                ttsText: null,
                nextPhase: RUT_PHASES.PROCESS_RUT,
                silent: false, // 👂 LISTEN: Habilita STT y grabación
                action: 'SET_STATE'
            };

        // ----------------------------------------------------------------
        // 3️⃣ PROCESAR: Evaluar transcript o NO_INPUT
        // ----------------------------------------------------------------
        case RUT_PHASES.PROCESS_RUT:
            // A) Evento NO_INPUT (Silencio)
            if (event === 'NO_INPUT' || !transcript || transcript.trim().length === 0) {
                const noInputCount = (state.noInputCount || 0) + 1;
                if (noInputCount >= 3) {
                    return {
                        ttsText: 'Lo siento, no he podido escucharte. Por favor intenta llamar nuevamente más tarde.',
                        shouldHangup: true,
                    };
                }
                // Retry Audio -> LISTEN_RUT
                return {
                    audio: 'quintero/ask_rut_retry',
                    nextPhase: RUT_PHASES.LISTEN_RUT,
                    action: 'PLAY_AUDIO',
                    silent: true,
                    allowBargeIn: false,
                    statePatch: { noInputCount: noInputCount }
                };
            }

            // B) Input recibido -> Dispatch Webhook FORMAT_RUT
            return {
                action: {
                    type: 'WEBHOOK',
                    action: 'FORMAT_RUT',
                    rut_raw: transcript
                },
                nextPhase: 'HANDLE_FORMAT_RUT', // Wait for webhook response
                silent: true, // Internal processing
                statePatch: { noInputCount: 0 } // Reset counter success
            };

        // ----------------------------------------------------------------
        // 4️⃣ PROCESAR FORMATO (Respuesta Webhook)
        // ----------------------------------------------------------------
        case 'HANDLE_FORMAT_RUT':
            if (event === 'WEBHOOK_RESPONSE' && webhookData?.action === 'FORMAT_RUT') {
                const data = webhookData.data;

                if (data.ok && data.rut) {
                    // ✅ Formato correcto -> Validar Paciente
                    return {
                        action: {
                            type: 'WEBHOOK',
                            action: 'VALIDATE_PATIENT',
                            rut: data.rut
                        },
                        nextPhase: 'HANDLE_VALIDATE_PATIENT',
                        silent: true,
                        statePatch: { dni: data.rut }
                    };
                } else {
                    // ❌ Formato inválido
                    const invalidCount = (state.invalidCount || 0) + 1;
                    if (invalidCount >= 3) {
                        return {
                            ttsText: 'No he podido procesar tu RUT. Por favor intenta más tarde.',
                            shouldHangup: true
                        };
                    }
                    // Retry Audio -> LISTEN_RUT
                    return {
                        audio: 'quintero/ask_rut_retry',
                        nextPhase: RUT_PHASES.LISTEN_RUT,
                        action: 'PLAY_AUDIO',
                        silent: true,
                        allowBargeIn: false,
                        statePatch: { invalidCount: invalidCount }
                    };
                }
            }
            // Fallback
            return { nextPhase: RUT_PHASES.LISTEN_RUT, silent: false };

        // ----------------------------------------------------------------
        // 5️⃣ PROCESAR PACIENTE (Respuesta Webhook)
        // ----------------------------------------------------------------
        case 'HANDLE_VALIDATE_PATIENT':
            if (event === 'WEBHOOK_RESPONSE' && webhookData?.action === 'VALIDATE_PATIENT') {
                const data = webhookData.data;

                if (data.ok && data.patientFound) {
                    // ✅ Paciente encontrado
                    const patient = {
                        nombre_completo: data.nombre,
                        edad: data.edad
                    };

                    return {
                        // Dynamic Confirm TTS
                        ttsText: `Confirmo, ¿usted es ${data.nombre}?`,
                        nextPhase: RUT_PHASES.CONFIRM,
                        silent: false, // Listen for "Sí/No"
                        allowBargeIn: true, // Allow barge-in on confirmation
                        action: 'SET_STATE',
                        statePatch: {
                            rutPhase: RUT_PHASES.CONFIRM,
                            patient: patient,
                            nombre_paciente: data.nombre
                        }
                    };
                } else {
                    // ❌ Paciente no encontrado
                    return {
                        ttsText: 'No encontramos registros con ese RUT.',
                        nextPhase: RUT_PHASES.ERROR,
                        shouldHangup: true
                    };
                }
            }
            return { nextPhase: 'HANDLE_VALIDATE_PATIENT', silent: true };


        case RUT_PHASES.CONFIRM:
            // Simple confirmation logic
            if (transcript && (transcript.toLowerCase().includes('si') || transcript.toLowerCase().includes('correcto'))) {
                return {
                    ttsText: 'Gracias, continuamos con su atención',
                    nextPhase: RUT_PHASES.COMPLETE,
                    action: {
                        type: 'SET_STATE',
                        payload: {
                            updates: { rutPhase: RUT_PHASES.COMPLETE }
                        }
                    }
                };
            } else if (transcript) {
                return {
                    ttsText: 'Disculpe, no le entendí. ¿Es usted el paciente? Dígame sí o no.',
                    nextPhase: RUT_PHASES.CONFIRM,
                    silent: false
                };
            }
            // If entered with empty/silent, listen
            return { nextPhase: RUT_PHASES.CONFIRM, silent: false };
    }

    return { ttsText: null, nextPhase: state.rutPhase, silent: false };
}
