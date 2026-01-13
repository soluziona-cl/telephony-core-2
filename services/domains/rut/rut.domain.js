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
                nextPhase: 'WAIT_RUT_INPUT',
                action: 'PLAY_AUDIO',
                silent: true, // 🔒 Disable listening, force immediate transition
                statePatch: { rutPhase: 'WAIT_RUT_INPUT', noInputCount: 0, invalidCount: 0 }
            };

        // ----------------------------------------------------------------
        // 2️⃣ ESPERA: Abrir micrófono 
        // ----------------------------------------------------------------
        case 'WAIT_RUT_INPUT':
            // A) Evento NO_INPUT (Silencio detectado por engine)
            if (event === 'NO_INPUT') {
                const noInputCount = (state.noInputCount || 0) + 1;
                if (noInputCount >= 3) {
                    return {
                        ttsText: 'Lo siento, no he podido escucharte. Por favor intenta llamar nuevamente más tarde.',
                        shouldHangup: true,
                        action: { type: 'HANGUP' }
                    };
                }
                // Retry Audio -> Loop back to WAIT_RUT_INPUT
                // Uses silent: true for audio playback
                return {
                    audio: 'quintero/ask_rut_retry',
                    nextPhase: 'WAIT_RUT_INPUT',
                    action: 'PLAY_AUDIO',
                    silent: true,
                    statePatch: { noInputCount: noInputCount }
                };
            }

            // B) Input recibido (Transcript)
            if (transcript && transcript.trim().length > 0) {
                // 🚀 Dispatch Webhook: FORMAT_RUT
                return {
                    action: {
                        type: 'WEBHOOK',
                        action: 'FORMAT_RUT',
                        rut_raw: transcript
                    },
                    nextPhase: 'HANDLE_FORMAT_RUT', // Wait for webhook response
                    silent: true // Internal processing
                };
            }

            // C) Just entered from INIT (Silent transition) -> OPEN MIC
            // Engine's Silent Loop will call this immediately with empty transcript
            return {
                ttsText: null,
                nextPhase: 'WAIT_RUT_INPUT',
                silent: false // 👂 ENABLE LISTENING
            };

        // ----------------------------------------------------------------
        // 3️⃣ PROCESAR FORMATO (Respuesta Webhook)
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
                        statePatch: { dni: data.rut } // Save formatted RUT provisional
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
                    // Retry Audio
                    return {
                        audio: 'quintero/ask_rut_retry', // Could have specific "Invalid RUT" audio? Using retry for now.
                        nextPhase: 'WAIT_RUT_INPUT',
                        action: 'PLAY_AUDIO',
                        silent: true,
                        statePatch: { invalidCount: invalidCount }
                    };
                }
            }
            // Fallback if phantom call
            return { nextPhase: 'WAIT_RUT_INPUT', silent: false };

        // ----------------------------------------------------------------
        // 4️⃣ PROCESAR PACIENTE (Respuesta Webhook)
        // ----------------------------------------------------------------
        case 'HANDLE_VALIDATE_PATIENT':
            if (event === 'WEBHOOK_RESPONSE' && webhookData?.action === 'VALIDATE_PATIENT') {
                const data = webhookData.data;

                if (data.ok && data.patientFound) {
                    // ✅ Paciente encontrado
                    const patient = {
                        nombre_completo: data.nombre,
                        edad: data.edad
                        // Add other fields if webhook returns them
                    };

                    return {
                        // Dynamic Confirm TTS (using System Prompt Persona)
                        ttsText: `Confirmo, ¿usted es ${data.nombre}?`,
                        nextPhase: RUT_PHASES.CONFIRM,
                        action: { type: 'SET_STATE' },
                        silent: false, // Listen for "Sí/No"
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
            // Simple confirmation logic - assuming 'si' or similar positive intent
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
                // Retry or fail? For now simple retry or fallback to restart
                return {
                    ttsText: 'Disculpe, no le entendí. ¿Es usted el paciente? Dígame sí o no.',
                    nextPhase: RUT_PHASES.CONFIRM,
                    silent: false
                };
            }
            return { nextPhase: RUT_PHASES.CONFIRM, silent: false };
    }

    return { ttsText: null, nextPhase: state.rutPhase, silent: false };
}
