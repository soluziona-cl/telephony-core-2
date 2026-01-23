// =========================================================
// LIFECYCLE CONTRACT — Governance Central de Fases
// =========================================================
// 
// Este contrato define QUÉ acciones están permitidas/denegadas
// en cada fase del bot, independientemente del dominio específico.
//
// PRINCIPIO: El dominio decide QUÉ, el lifecycle decide CÓMO y CUÁNDO
// =========================================================

import { log } from '../../../lib/logger.js';
import redis from '../../../lib/redis.js';

/**
 * Lifecycle Contract - Define reglas operativas por fase
 * 
 * Cada fase tiene:
 * - allow: acciones permitidas
 * - deny: acciones explícitamente bloqueadas
 * - requires: recursos que DEBEN existir
 * - teardownAllowed: si se puede destruir bridge/snoop
 */
export const LIFECYCLE_CONTRACT = {
    START_GREETING: {
        allow: ['PLAYBACK', 'CREATE_BRIDGE'],
        deny: ['STT', 'HANGUP', 'DESTROY_BRIDGE', 'DESTROY_SNOOP'],
        requires: ['BRIDGE'],
        teardownAllowed: false,
        advanceTurnAfterPlayback: true
    },

    LISTEN_RUT: {
        allow: ['STT', 'CREATE_SNOOP'],
        deny: ['PLAYBACK', 'DESTROY_SNOOP', 'DESTROY_BRIDGE', 'HANGUP'],
        requires: ['BRIDGE', 'SNOOP'],
        teardownAllowed: false,
        advanceTurnAfterPlayback: false
    },

    LISTEN_OPTION: {
        allow: ['STT', 'CREATE_SNOOP'],
        deny: ['PLAYBACK', 'DESTROY_SNOOP', 'DESTROY_BRIDGE', 'HANGUP'],
        requires: ['BRIDGE', 'SNOOP'],
        teardownAllowed: false,
        advanceTurnAfterPlayback: false
    },

    LISTEN_CONFIRMATION: {
        allow: ['STT', 'CREATE_SNOOP'],
        deny: ['PLAYBACK', 'DESTROY_SNOOP', 'DESTROY_BRIDGE', 'HANGUP'],
        requires: ['BRIDGE', 'SNOOP'],
        teardownAllowed: false,
        advanceTurnAfterPlayback: false
    },

    ASK_SPECIALTY: {
        allow: ['PLAYBACK', 'STT', 'CREATE_SNOOP'],
        deny: ['DESTROY_SNOOP', 'DESTROY_BRIDGE', 'HANGUP'],
        requires: ['BRIDGE', 'SNOOP'],
        teardownAllowed: false,
        advanceTurnAfterPlayback: true
    },

    ASK_DATE: {
        allow: ['PLAYBACK', 'STT', 'CREATE_SNOOP'],
        deny: ['DESTROY_SNOOP', 'DESTROY_BRIDGE', 'HANGUP'],
        requires: ['BRIDGE', 'SNOOP'],
        teardownAllowed: false,
        advanceTurnAfterPlayback: true
    },

    NO_AVAILABILITY: {
        allow: ['PLAYBACK'],
        deny: ['STT', 'DESTROY_BRIDGE', 'HANGUP'],
        requires: ['BRIDGE'],
        teardownAllowed: false,
        advanceTurnAfterPlayback: true
    },

    CONFIRM_APPOINTMENT: {
        allow: ['PLAYBACK', 'STT', 'CREATE_SNOOP'],
        deny: ['DESTROY_BRIDGE', 'HANGUP'],
        requires: ['BRIDGE', 'SNOOP'],
        teardownAllowed: false,
        advanceTurnAfterPlayback: true
    },

    END_CALL: {
        allow: ['PLAYBACK', 'HANGUP', 'DESTROY_BRIDGE', 'DESTROY_SNOOP'],
        deny: ['STT', 'CREATE_SNOOP'],
        requires: [],
        teardownAllowed: true,
        advanceTurnAfterPlayback: true
    }
};

/**
 * Valida si una acción está permitida en la fase actual
 * 
 * @param {string} phase - Fase actual
 * @param {string} action - Acción a validar (PLAYBACK, STT, DESTROY_BRIDGE, etc.)
 * @param {object} logContext - Contexto adicional para logs (opcional)
 * @returns {boolean} - true si está permitida, false si está denegada
 */
export async function isActionAllowed(phase, action, logContext = {}) {
    // 📊 LOG DETALLADO: Estado inicial de la validación
    log("debug", `🔒 [LIFECYCLE] Validando acción: phase=${phase || 'NULL'}, action=${action}, context=${JSON.stringify(logContext)}`);
    
    if (!phase || !LIFECYCLE_CONTRACT[phase]) {
        log("warn", `🔒 [LIFECYCLE] ❌ Fase desconocida o inválida: ${phase || 'NULL'} - Acción ${action} DENEGADA por defecto`);
        return false; // Fase desconocida = nada permitido
    }

    const contract = LIFECYCLE_CONTRACT[phase];
    
    // 📊 LOG DETALLADO: Contrato de la fase
    log("debug", `🔒 [LIFECYCLE] Contrato de fase ${phase}: allow=[${contract.allow?.join(', ') || 'none'}], deny=[${contract.deny?.join(', ') || 'none'}], requires=[${contract.requires?.join(', ') || 'none'}], teardownAllowed=${contract.teardownAllowed}`);

    // 🎯 EXCEPCIÓN: PLAYBACK condicional en LISTEN_RUT tras rechazo de webhook
    if (phase === 'LISTEN_RUT' && action === 'PLAYBACK') {
        const callKey = logContext.linkedId || logContext.callKey || logContext.channelId;
        if (callKey) {
            const webhookRejectKey = `rut:webhook:rejected:${callKey}`;
            const webhookRejectRaw = await redis.get(webhookRejectKey);
            
            if (webhookRejectRaw) {
                try {
                    const webhookReject = JSON.parse(webhookRejectRaw);
                    if (webhookReject.ok === false && (webhookReject.reason === 'INVALID_RUT_FORMAT' || webhookReject.reason === 'CARDINAL_NUMBER' || webhookReject.reason === 'CONFUSION_PHRASE' || webhookReject.reason === 'INSUFFICIENT_DIGITS' || webhookReject.reason === 'NO_DIGIT_SEQUENCE' || webhookReject.reason === 'TEXT_WITHOUT_DIGITS' || webhookReject.reason === 'INVALID_RUT_FORMAT_PATTERN')) {
                        log("info", `🔒 [LIFECYCLE] ✅ PLAYBACK PERMITIDO en LISTEN_RUT (excepción: webhook rechazado, reason=${webhookReject.reason}) - Permitiendo re-prompt`);
                        // Limpiar la key para que solo se permita una vez
                        await redis.del(webhookRejectKey);
                        return true;
                    }
                } catch (e) {
                    log("warn", `⚠️ [LIFECYCLE] Error parseando webhookReject: ${e.message}`);
                }
            }
        }
    }

    // 1. Verificar deny explícito (máxima prioridad)
    if (contract.deny && contract.deny.includes(action)) {
        log("warn", `🔒 [LIFECYCLE] ❌ Acción ${action} DENEGADA en fase ${phase} (está en lista deny)`);
        return false;
    }

    // 2. Verificar allow explícito
    if (contract.allow && contract.allow.includes(action)) {
        log("info", `🔒 [LIFECYCLE] ✅ Acción ${action} PERMITIDA en fase ${phase} (está en lista allow)`);
        return true;
    }

    // 3. Si no está en allow ni deny, denegar por defecto (seguridad)
    log("warn", `🔒 [LIFECYCLE] ❌ Acción ${action} DENEGADA en fase ${phase} (no está en allow ni deny - política de seguridad)`);
    return false;
}

/**
 * Valida si un recurso es requerido en la fase actual
 * 
 * @param {string} phase - Fase actual
 * @param {string} resource - Recurso a validar (BRIDGE, SNOOP, etc.)
 * @param {object} logContext - Contexto adicional para logs (opcional)
 * @returns {boolean} - true si es requerido
 */
export function isResourceRequired(phase, resource, logContext = {}) {
    if (!phase || !LIFECYCLE_CONTRACT[phase]) {
        log("debug", `🔒 [LIFECYCLE] Fase ${phase || 'NULL'} no existe - recurso ${resource} NO requerido`);
        return false;
    }

    const contract = LIFECYCLE_CONTRACT[phase];
    const isRequired = contract.requires && contract.requires.includes(resource);
    
    log("debug", `🔒 [LIFECYCLE] Recurso ${resource} en fase ${phase}: ${isRequired ? 'REQUERIDO' : 'NO requerido'} (requires=[${contract.requires?.join(', ') || 'none'}])`);
    
    return isRequired;
}

/**
 * Valida si el teardown está permitido en la fase actual
 * 
 * @param {string} phase - Fase actual
 * @param {object} logContext - Contexto adicional para logs (opcional)
 * @returns {boolean} - true si se puede hacer teardown
 */
export function isTeardownAllowed(phase, logContext = {}) {
    if (!phase || !LIFECYCLE_CONTRACT[phase]) {
        log("warn", `🔒 [LIFECYCLE] Fase ${phase || 'NULL'} no existe - teardown DENEGADO por defecto`);
        return false;
    }

    const contract = LIFECYCLE_CONTRACT[phase];
    const allowed = contract.teardownAllowed === true;
    
    log("info", `🔒 [LIFECYCLE] Teardown en fase ${phase}: ${allowed ? 'PERMITIDO' : 'DENEGADO'} (teardownAllowed=${contract.teardownAllowed})`);
    
    return allowed;
}

/**
 * Obtiene el contrato completo de una fase
 * 
 * @param {string} phase - Fase actual
 * @param {boolean} logDetails - Si debe loguear detalles (default: true)
 * @returns {object|null} - Contrato de la fase o null si no existe
 */
export function getPhaseContract(phase, logDetails = true) {
    if (!phase || !LIFECYCLE_CONTRACT[phase]) {
        if (logDetails) {
            log("warn", `🔒 [LIFECYCLE] Contrato no encontrado para fase: ${phase || 'NULL'}`);
        }
        return null;
    }

    const contract = LIFECYCLE_CONTRACT[phase];
    
    if (logDetails) {
        log("info", `🔒 [LIFECYCLE] Contrato completo de fase ${phase}:`, {
            allow: contract.allow,
            deny: contract.deny,
            requires: contract.requires,
            teardownAllowed: contract.teardownAllowed,
            advanceTurnAfterPlayback: contract.advanceTurnAfterPlayback
        });
    }
    
    return contract;
}

/**
 * Valida que una fase existe en el contrato
 * 
 * @param {string} phase - Fase a validar
 * @returns {boolean} - true si la fase existe
 */
export function isValidPhase(phase) {
    return phase && phase in LIFECYCLE_CONTRACT;
}
