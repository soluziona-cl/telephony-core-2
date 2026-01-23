import { RUT_PHASES } from './rut.phases.js';
import { flowTrace } from '../../core/telemetry/flow-trace.js';
import { log } from '../../../lib/logger.js';

const TRACE_FILE = 'services/domains/rut/rut.domain.js';

function traceReturn(fn, ctx, resp) {
    log('debug', '🧭 [DOMAIN_TRACE]', {
        file: TRACE_FILE,
        fn,
        event: ctx?.event,
        phaseIn: ctx?.state?.rutPhase,
        phaseOut: resp?.nextPhase,
        action: resp?.action,
        silent: resp?.silent,
        skipInput: resp?.skipInput ?? resp?.skipUserInput,
        audio: resp?.audio,
        tts: resp?.ttsText ? 'YES' : 'NO'
    });
    return resp;
}

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

    log('info', '[DOMAIN][ENTER]', {
        domain: 'quintero',
        phase: state.rutPhase,
        turn: ctx.turn || '?',
        businessState: {
            identificador: state.identificador,
            rutDetectado: state.dni || null
        }
    });

    switch (state.rutPhase) {
        // ----------------------------------------------------------------
        // 1️⃣ INICIO: Reproducir Audio de Petición (Sin escucha)
        // ----------------------------------------------------------------
        case RUT_PHASES.INIT:
            return traceReturn('RUT_PHASES.INIT', ctx, {
                audio: 'quintero/ask_rut',
                ttsText: null,
                nextPhase: RUT_PHASES.LISTEN_RUT,
                action: 'PLAY_AUDIO',
                silent: true,
                allowBargeIn: false
            });

        // ----------------------------------------------------------------
        // 2️⃣ ESCUCHA: Activar micrófono (Sin audio)
        // ----------------------------------------------------------------
        case RUT_PHASES.LISTEN_RUT:
            // This phase waits for input.
            // If we have a transcript (from previous active listening turn), verify/process it.
            // If NOT (e.g. first turn after silent audio), we enable listening and stay here.

            if (transcript && transcript.trim().length > 0) {
                // We heard something! Delegate to PROCESS logic
                // (We can assume 'PROCESS_RUT' will handle the validation of this transcript)
                return traceReturn('RUT_PHASES.LISTEN_RUT:hasTranscript', ctx, {
                    ttsText: null,
                    nextPhase: RUT_PHASES.PROCESS_RUT,
                    silent: true, // Internal transition to process
                    action: 'SET_STATE'
                });
            }

            // No input yet (or just came from silent audio) -> Stay and Listen
            // No input yet (or just came from silent audio) -> Stay and Listen
            const listenResponse = {
                ttsText: null,
                nextPhase: RUT_PHASES.LISTEN_RUT,
                silent: false, // 👂 LISTEN: Enable STT for next turn
                skipUserInput: false, // Explicitly allow input
                action: 'USE_ENGINE', // Explicitly request engine usage (STT)
                listen: true // Semantic flag
            };

            log('info', '[DOMAIN][RESPONSE]', listenResponse);
            return traceReturn('RUT_PHASES.LISTEN_RUT:listen', ctx, listenResponse);

        // ----------------------------------------------------------------
        // 3️⃣ PROCESAR: Evaluar transcript o NO_INPUT
        // ----------------------------------------------------------------
        case RUT_PHASES.PROCESS_RUT:
            // A) Evento NO_INPUT (Silencio)
            // A) Evento NO_INPUT (Silencio)
            if (event === 'NO_INPUT' || !transcript || transcript.trim().length === 0) {
                const silenceCount = (state.silenceCount || 0) + 1;
                log('warn', '[DOMAIN][SILENCE]', {
                    count: silenceCount,
                    phase: state.rutPhase
                });

                if (silenceCount >= 3) {
                    const hangupResponse = {
                        ttsText: 'No logré escucharte, finalizaremos la llamada.',
                        nextPhase: 'END',
                        action: 'HANGUP',
                        shouldHangup: true
                    };
                    log('info', '[DOMAIN][RESPONSE] (Max Silence)', hangupResponse);
                    return traceReturn('RUT_PHASES.PROCESS_RUT:maxSilence', ctx, hangupResponse);
                }

                // Retry Audio -> LISTEN_RUT
                const retryResponse = {
                    audio: 'quintero/ask_rut_retry',
                    nextPhase: RUT_PHASES.LISTEN_RUT,
                    action: 'PLAY_AUDIO',
                    silent: true,
                    allowBargeIn: false,
                    statePatch: { silenceCount: silenceCount } // Persist silence count
                };
                log('info', '[DOMAIN][RESPONSE]', retryResponse);
                return traceReturn('RUT_PHASES.PROCESS_RUT:retry', ctx, retryResponse);
            }

            // B) Input recibido -> Dispatch Webhook FORMAT_RUT
            return traceReturn('RUT_PHASES.PROCESS_RUT:formatWebhook', ctx, {
                action: {
                    type: 'WEBHOOK',
                    action: 'FORMAT_RUT',
                    rut_raw: transcript
                },
                nextPhase: 'HANDLE_FORMAT_RUT', // Wait for webhook response
                silent: true, // Internal processing
                statePatch: { noInputCount: 0 } // Reset counter success
            });

        // ----------------------------------------------------------------
        // 4️⃣ PROCESAR FORMATO (Respuesta Webhook)
        // ----------------------------------------------------------------
        case 'HANDLE_FORMAT_RUT':
            if (event === 'WEBHOOK_RESPONSE' && webhookData?.action === 'FORMAT_RUT') {
                const data = webhookData.data;

                if (data.ok && data.rut) {
                    // ✅ Formato correcto -> Validar Paciente
                    return traceReturn('HANDLE_FORMAT_RUT:ok', ctx, {
                        action: {
                            type: 'WEBHOOK',
                            action: 'VALIDATE_PATIENT',
                            rut: data.rut
                        },
                        nextPhase: 'HANDLE_VALIDATE_PATIENT',
                        silent: true,
                        statePatch: { dni: data.rut }
                    });
                } else {
                    // ❌ Formato inválido
                    const invalidCount = (state.invalidCount || 0) + 1;
                    if (invalidCount >= 3) {
                        return traceReturn('HANDLE_FORMAT_RUT:invalidMax', ctx, {
                            ttsText: 'No he podido procesar tu RUT. Por favor intenta más tarde.',
                            shouldHangup: true
                        });
                    }
                    // Retry Audio -> LISTEN_RUT
                    return traceReturn('HANDLE_FORMAT_RUT:invalidRetry', ctx, {
                        audio: 'quintero/ask_rut_retry',
                        nextPhase: RUT_PHASES.LISTEN_RUT,
                        action: 'PLAY_AUDIO',
                        silent: true,
                        allowBargeIn: false,
                        statePatch: { invalidCount: invalidCount }
                    });
                }
            }
            // Fallback
            return traceReturn('HANDLE_FORMAT_RUT:fallback', ctx, { nextPhase: RUT_PHASES.LISTEN_RUT, silent: false });

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

                    return traceReturn('HANDLE_VALIDATE_PATIENT:ok', ctx, {
                        // Dynamic Confirm TTS
                        ttsText: `Confirmo, ¿usted es ${data.nombre}?`,
                        nextPhase: RUT_PHASES.CONFIRM,
                        silent: false, // Listen for "Sí/No"
                        allowBargeIn: true, // Allow barge-in on confirmation
                        action: 'SET_STATE',
                        statePatch: {
                            rutPhase: RUT_PHASES.CONFIRM,
                            patient: patient,
                            nombre_paciente: data.nombre,
                            identificador: data.rut // ✅ BusinessState: Identificador confirmado
                        }
                    });
                } else {
                    // ❌ Paciente no encontrado
                    return traceReturn('HANDLE_VALIDATE_PATIENT:notFound', ctx, {
                        ttsText: 'No encontramos registros con ese RUT.',
                        nextPhase: RUT_PHASES.ERROR,
                        shouldHangup: true
                    });
                }
            }
            return traceReturn('HANDLE_VALIDATE_PATIENT:fallback', ctx, { nextPhase: 'HANDLE_VALIDATE_PATIENT', silent: true });


        case RUT_PHASES.CONFIRM:
            // Simple confirmation logic
            if (transcript && (transcript.toLowerCase().includes('si') || transcript.toLowerCase().includes('correcto'))) {
                return traceReturn('RUT_PHASES.CONFIRM:yes', ctx, {
                    ttsText: 'Gracias, continuamos con su atención',
                    nextPhase: RUT_PHASES.COMPLETE,
                    action: {
                        type: 'SET_STATE',
                        payload: {
                            updates: { rutPhase: RUT_PHASES.COMPLETE }
                        }
                    }
                });
            } else if (transcript) {
                return traceReturn('RUT_PHASES.CONFIRM:no', ctx, {
                    ttsText: 'Disculpe, no le entendí. ¿Es usted el paciente? Dígame sí o no.',
                    nextPhase: RUT_PHASES.CONFIRM,
                    silent: false
                });
            }
            // If entered with empty/silent, listen
            return traceReturn('RUT_PHASES.CONFIRM:listen', ctx, { nextPhase: RUT_PHASES.CONFIRM, silent: false });
    }

    return traceReturn('RUT_PHASES:default', ctx, { ttsText: null, nextPhase: state.rutPhase, silent: false });
}
