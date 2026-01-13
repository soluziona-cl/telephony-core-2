import { log } from '../../../lib/logger.js';
import { inboundConfig as config } from '../engine/config.js';

export function flowTrace({
    traceId,
    layer,        // ENGINE | DOMAIN | POLICY | REPOSITORY
    flow,         // RUT | AGENDA | TRANSFER | FAREWELL | SILENCE
    step,         // WAIT_BODY | CONFIRM | COMPLETE | etc
    depth,        // 1 | 2 | 3
    module,       // ruta del archivo
    fn,           // función ejecutada
    action,       // acción semántica
    result        // OK | FAIL | FOUND | NOT_FOUND | SKIP
}) {
    if (!config.engine || !config.engine.traceFlow) return;

    log('info', {
        type: 'FLOW_TRACE',
        traceId,
        layer,
        flow,
        step,
        depth,
        module,
        fn,
        action,
        result,
        ts: new Date().toISOString()
    });
}
