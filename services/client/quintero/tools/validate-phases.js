// /services/client/quintero/tools/validate-phases.js
// Objetivo: detectar silencios implícitos y respuestas incompletas en fases críticas.

import { runRutDomain } from '../../../domains/rut/rut.domain.js';
import { RUT_PHASES } from '../../../domains/rut/rut.phases.js';

const LISTEN_PHASE_PREFIXES = ['LISTEN_', 'WAIT_'];
const REQUIRED_KEYS = ['action', 'nextPhase'];

function validatePhaseResponse(phase, res) {
    const errors = [];

    if (!res) {
        return [`Response is null/undefined`];
    }

    for (const k of REQUIRED_KEYS) {
        if (!(k in res)) errors.push(`Missing key '${k}'`);
    }

    // Si la fase suena a escucha, silent:false debe ser explícito
    const shouldListen = LISTEN_PHASE_PREFIXES.some(p => phase.startsWith(p)) && !phase.includes('WAIT_BODY'); // Excluir WAIT_BODY antiguo si es legacy

    // Para RUT_PHASES.LISTEN_RUT especificamente
    if (phase === 'LISTEN_RUT' && res.silent !== false) {
        errors.push(`Listen phase requires silent:false (got ${String(res.silent)})`);
    }

    // action debe ser string del contrato (evitar {type:'SET_STATE'} inconsistente)
    // Aunque engine permite objeto, validamos string por consistencia si se desea, 
    // pero el engine acepta ambos. Dejamos warning si es objeto complejo sin type.
    if (res.action && typeof res.action === 'object' && !res.action.type) {
        errors.push(`action object missing type property`);
    }

    return errors;
}

async function check() {
    console.log("🔍 Validating RUT Domain Phases...");

    // Simular contexto mínimo
    const ctx = {
        transcript: '',
        state: { rutPhase: '' },
        event: 'TURN'
    };

    let hasErrors = false;

    for (const phase of Object.values(RUT_PHASES)) {
        ctx.state.rutPhase = phase;

        try {
            const res = await runRutDomain(ctx);
            const errs = validatePhaseResponse(phase, res);

            if (errs.length) {
                hasErrors = true;
                console.error(`❌ ${phase}:`);
                for (const e of errs) console.error(`   - ${e}`);
                console.error(`   - Actual: ${JSON.stringify(res)}`);
            } else {
                console.log(`✅ ${phase} OK (silent=${res.silent})`);
            }
        } catch (err) {
            console.error(`❌ ${phase} CRASH: ${err.message}`);
            hasErrors = true;
        }
    }

    process.exit(hasErrors ? 1 : 0);
}

check();
