import {
    getPatientByRut,
} from '../../core/engine/legacy-compat/db-queries.js';
import { flowTrace } from '../../core/telemetry/flow-trace.js';

export async function fetchPatient(rut, sessionId = 'unknown') {
    flowTrace({
        traceId: sessionId, // sessionId should ideally be passed to repo
        layer: 'REPOSITORY',
        flow: 'RUT',
        step: 'FETCH_PATIENT',
        depth: 3,
        module: 'domains/rut/rut.repository.js',
        fn: 'fetchPatient',
        action: 'EXEC_SP',
        result: 'START'
    });
    const res = await getPatientByRut(rut);
    flowTrace({
        traceId: sessionId,
        layer: 'REPOSITORY',
        flow: 'RUT',
        step: 'FETCH_PATIENT',
        depth: 3,
        module: 'domains/rut/rut.repository.js',
        fn: 'fetchPatient',
        action: 'EXEC_SP',
        result: res ? 'FOUND' : 'NOT_FOUND'
    });
    return res;
}
