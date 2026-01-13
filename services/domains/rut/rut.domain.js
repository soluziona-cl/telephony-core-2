import { RUT_PHASES } from './rut.phases.js';
import { parseAndValidateRut } from './rut.validators.js';
import { fetchPatient } from './rut.repository.js';
import { flowTrace } from '../../core/telemetry/flow-trace.js';

export async function runRutDomain(ctx) {
    const { transcript, state } = ctx;

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
        case RUT_PHASES.INIT:
            // If we are in INIT, typically the prompt has asked for the RUT, so we expect the user to provide it now.
            // Or we send the initial prompt. 
            // Based on user snippet:
            return {
                ttsText: 'Por favor indique su RUT sin dígito verificador',
                nextPhase: RUT_PHASES.WAIT_BODY,
                action: {
                    type: 'SET_STATE',
                    payload: {
                        updates: { rutPhase: RUT_PHASES.WAIT_BODY }
                    }
                }
            };

        case RUT_PHASES.WAIT_BODY:
        case 'WAIT_BODY': // Compatibility with Quintero legacy phase name if needed, but we should enforce RUT_PHASES
            {
                const result = parseAndValidateRut(transcript);
                if (!result.valid) {
                    return {
                        ttsText: 'El RUT no es válido, repítalo por favor',
                        nextPhase: RUT_PHASES.WAIT_BODY
                    };
                }

                const patient = await fetchPatient(result.rut);
                if (!patient) {
                    return {
                        ttsText: 'No encontramos registros con ese RUT',
                        nextPhase: RUT_PHASES.ERROR,
                        shouldHangup: true
                    };
                }

                state.patient = patient;
                state.dni = result.rut; // Sync legacy field if needed

                return {
                    ttsText: `Confirmo, ¿usted es ${patient.nombre_completo || patient.nombre || 'el paciente'}?`,
                    nextPhase: RUT_PHASES.CONFIRM,
                    action: {
                        type: 'SET_STATE',
                        payload: {
                            updates: {
                                rutPhase: RUT_PHASES.CONFIRM,
                                patient: patient,
                                dni: result.rut,
                                nombre_paciente: patient.nombre_completo || patient.nombre
                            }
                        }
                    }
                };
            }

        case RUT_PHASES.CONFIRM:
            // Simple confirmation logic - assuming 'si' or similar positive intent
            if (transcript.toLowerCase().includes('si') || transcript.toLowerCase().includes('correcto')) {
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
            } else {
                // Retry or fail? For now simple retry or fallback to restart
                return {
                    ttsText: 'Disculpe, no le entendí. ¿Es usted el paciente? Dígame sí o no.',
                    nextPhase: RUT_PHASES.CONFIRM
                };
            }
    }

    return { ttsText: null, nextPhase: state.rutPhase };
}
