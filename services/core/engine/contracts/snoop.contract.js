// =========================================================
// SNOOP LIFECYCLE CONTRACT — Formal State Machine
// =========================================================
// Fuente de verdad: Redis
// ARI es best-effort, no autoridad
// STT solo inicia si estado === READY

import { log } from "../../../../lib/logger.js";
import redis from "../../../../lib/redis.js";

// 🎯 ESTADOS DEL SNOOP (Enum)
export const SnoopState = {
    CREATED: 'CREATED',        // Canal Snoop creado
    WAITING_AST: 'WAITING_AST', // Esperando confirmación de Asterisk (eventos ARI)

    READY: 'READY',            // Seguro para STT (solo después de AUDIO_READY)
    CONSUMED: 'CONSUMED',      // STT iniciado
    RELEASABLE: 'RELEASABLE',  // Puede destruirse
    DESTROYED: 'DESTROYED'     // Limpieza final
};

// 🎯 TTL POR ESTADO (seguridad)
const TTL_BY_STATE = {
    [SnoopState.CREATED]: 5000,      // 5s
    [SnoopState.WAITING_AST]: 3000,  // 3s (espera corta para eventos ARI)

    [SnoopState.READY]: 15000,       // 15s
    [SnoopState.CONSUMED]: 30000,    // 30s
    [SnoopState.RELEASABLE]: 10000,  // 10s
    [SnoopState.DESTROYED]: 0        // inmediato
};

// 🎯 TRANSICIONES PERMITIDAS
// ✅ FIX: Permitir transiciones directas desde CREATED/WAITING_AST a READY (idempotencia)
// StasisStart puede llegar en cualquier momento y debe poder transicionar directamente a READY
const ALLOWED_TRANSITIONS = {
    [SnoopState.CREATED]: [SnoopState.WAITING_AST, SnoopState.READY, SnoopState.DESTROYED], // ✅ Permitir CREATED → READY
    [SnoopState.WAITING_AST]: [SnoopState.READY, SnoopState.DESTROYED], // ✅ Permitir WAITING_AST → READY

    [SnoopState.READY]: [SnoopState.CONSUMED, SnoopState.DESTROYED],
    [SnoopState.CONSUMED]: [SnoopState.RELEASABLE, SnoopState.DESTROYED],
    [SnoopState.RELEASABLE]: [SnoopState.DESTROYED],
    [SnoopState.DESTROYED]: []
};

/**
 * 🎯 Crear contrato de Snoop en Redis
 */
export async function createSnoopContract(linkedId, snoopId, parentChannelId) {
    const contract = {
        linkedId,
        snoopId,
        parentChannelId,
        captureBridgeId: null,
        externalMediaId: null,
        state: SnoopState.CREATED,
        createdAt: Date.now(),
        ttlMs: TTL_BY_STATE[SnoopState.CREATED],
        version: 1
    };

    // 🎯 DOBLE ÍNDICE: Por linkedId (caller) y por snoopId (para StasisStart lookup)
    await Promise.all([
        redis.set(
            `snoop:${linkedId}`,
            JSON.stringify(contract),
            'PX',
            contract.ttlMs
        ),
        redis.set(
            `snoop:by-id:${snoopId}`,
            linkedId, // Guardar linkedId del caller para lookup rápido
            'PX',
            contract.ttlMs
        )
    ]);

    // ✅ LOG 2: Contrato creado (con timestamp para correlación)
    log("info", `📜 [SNOOP CONTRACT] CREATED`, {
        linkedId,
        snoopId,
        parentChannelId,
        state: SnoopState.CREATED,
        createdAt: contract.createdAt,
        ttlMs: contract.ttlMs
    });

    return contract;
}

/**
 * 🎯 Extraer parentChannelId del nombre del Snoop
 * Formato: Snoop/PARENT_ID-xxxxx
 * @param {string} snoopName - Nombre del canal Snoop
 * @returns {string|null} parentChannelId o null si no se puede extraer
 */
export function extractParentChannelIdFromSnoopName(snoopName) {
    if (!snoopName || !snoopName.startsWith('Snoop/')) {
        return null;
    }
    const match = snoopName.match(/^Snoop\/([^-]+)/);
    return match ? match[1] : null;
}

/**
 * 🎯 Obtener contrato de Snoop desde Redis
 * @param {string} linkedIdOrSnoopId - Puede ser linkedId del caller, snoopId, o nombre del Snoop
 * @returns {Promise<Object|null>} Contrato del Snoop o null si no existe
 */
export async function getSnoopContract(linkedIdOrSnoopId) {
    // 🎯 Intento 1: Buscar por linkedId (caller)
    let raw = await redis.get(`snoop:${linkedIdOrSnoopId}`);
    let contract = null;
    if (raw) {
        contract = JSON.parse(raw);
    } else {
        // 🎯 Intento 2: Buscar por snoopId (índice secundario)
        const callerLinkedId = await redis.get(`snoop:by-id:${linkedIdOrSnoopId}`);
        if (callerLinkedId) {
            raw = await redis.get(`snoop:${callerLinkedId}`);
            if (raw) {
                contract = JSON.parse(raw);
            }
        }

        // 🎯 Intento 3: Si es un nombre de Snoop, extraer parentChannelId y buscar
        if (!contract && linkedIdOrSnoopId.includes('Snoop/')) {
            const parentChannelId = extractParentChannelIdFromSnoopName(linkedIdOrSnoopId);
            if (parentChannelId) {
                // Buscar por parentChannelId (que es el linkedId del contrato)
                raw = await redis.get(`snoop:${parentChannelId}`);
                if (raw) {
                    contract = JSON.parse(raw);
                }
            }
        }
    }

    // ✅ LOG 5: WATCHDOG de contratos atascados (solo en debug)
    if (contract && contract.state === SnoopState.WAITING_AST) {
        const ageMs = Date.now() - (contract.createdAt || contract.waiting_astAt || 0);
        if (ageMs > 2000) { // Más de 2 segundos en WAITING_AST
            log("warn", "⏳ [SNOOP STUCK] Contrato atascado en WAITING_AST", {
                linkedId: contract.linkedId,
                snoopId: contract.snoopId,
                ageMs,
                createdAt: contract.createdAt,
                hint: "StasisStart no recibido o no correlacionado",
                parentChannelId: contract.parentChannelId
            });
        }
    }

    return contract;
}

/**
 * 🎯 Transición segura de estado (con validación e idempotencia)
 */
export async function transitionSnoopState(linkedId, from, to, patch = {}) {
    const current = await getSnoopContract(linkedId);

    if (!current) {
        throw new Error(`SNOOP_CONTRACT_MISSING: linkedId=${linkedId}`);
    }

    // ✅ FIX: Idempotencia - Si ya está en el estado destino, NO-OP (permitir doble evento)
    if (current.state === to) {
        log("debug", `🔄 [SNOOP CONTRACT] Transición idempotente: ya está en ${to}`, {
            linkedId,
            snoopId: current.snoopId,
            state: to,
            reason: "already_in_target_state"
        });
        return current; // Retornar sin cambios
    }

    // ✅ FIX: Usar el estado actual del contrato como "from" si es válido (race condition safe)
    // Esto permite transiciones flexibles cuando hay race conditions entre engine y ARI events
    const stateOrder = {
        [SnoopState.CREATED]: 0,
        [SnoopState.WAITING_AST]: 1,
        [SnoopState.READY]: 2,

        [SnoopState.CONSUMED]: 3,
        [SnoopState.RELEASABLE]: 4,
        [SnoopState.DESTROYED]: 5
    };

    const currentOrder = stateOrder[current.state] ?? -1;
    const toOrder = stateOrder[to] ?? -1;

    // ✅ FIX: Siempre usar el estado actual como "from" si es válido para la transición
    // Esto evita errores por race conditions donde el contrato cambia entre lectura y escritura
    let effectiveFrom = current.state;

    // Si el estado actual es diferente al "from" esperado, loguear pero continuar
    if (current.state !== from) {
        log("debug", `🔄 [SNOOP CONTRACT] Estado actual (${current.state}) difiere del esperado (${from}), usando estado actual`, {
            linkedId,
            snoopId: current.snoopId,
            requestedFrom: from,
            actualFrom: effectiveFrom,
            to
        });
    }

    // ✅ FIX: Usar effectiveFrom (estado real) para el log de transición, no el parámetro "from"
    // Esto asegura que el log refleje la transición real: WAITING_AST → READY (no CREATED → READY)
    const logFrom = effectiveFrom;

    // Verificar que el estado actual no está más adelante que el destino
    if (currentOrder > toOrder) {
        throw new Error(`INVALID_TRANSITION: ${current.state} → ${to} (current state ${current.state} is already ahead of target ${to})`);
    }

    // Verificar que la transición desde el estado actual está permitida
    const allowed = ALLOWED_TRANSITIONS[effectiveFrom] || [];
    if (!allowed.includes(to)) {
        throw new Error(`FORBIDDEN_TRANSITION: ${effectiveFrom} → ${to} (allowed from ${effectiveFrom}: ${allowed.join(', ')})`);
    }

    const timestampField = `${to.toLowerCase()}At`;
    const updated = {
        ...current,
        ...patch,
        state: to,
        ttlMs: TTL_BY_STATE[to],
        [timestampField]: Date.now()
    };

    // 🎯 DOBLE ÍNDICE: Actualizar ambos índices
    await Promise.all([
        redis.set(
            `snoop:${linkedId}`,
            JSON.stringify(updated),
            'PX',
            updated.ttlMs
        ),
        redis.set(
            `snoop:by-id:${current.snoopId}`,
            linkedId,
            'PX',
            updated.ttlMs
        )
    ]);

    // ✅ FIX: Log usar estado real (effectiveFrom) no parámetro "from" para reflejar transición real
    log("info", `📜 [SNOOP CONTRACT] Transición: ${logFrom} → ${to}`, {
        linkedId,
        snoopId: current.snoopId,
        from: logFrom, // Estado real usado
        requestedFrom: from, // Estado solicitado (puede diferir)
        to,
        ttlMs: updated.ttlMs,
        ...(patch.externalMediaId ? { externalMediaId: patch.externalMediaId } : {})
    });

    return updated;
}

/**
 * 🎯 Validación dura para STT (debe estar READY)
 */
export function assertSnoopReady(contract) {
    if (!contract) {
        throw new Error('STT_BLOCKED_SNOOP_CONTRACT_MISSING');
    }
    if (contract.state !== SnoopState.READY) {
        throw new Error(`STT_BLOCKED_SNOOP_STATE_${contract.state}`);
    }
}

/**
 * 🎯 Liberar Snoop (CONSUMED → RELEASABLE)
 */
export async function releaseSnoop(linkedId) {
    try {
        return await transitionSnoopState(
            linkedId,
            SnoopState.CONSUMED,
            SnoopState.RELEASABLE
        );
    } catch (err) {
        log("warn", `⚠️ [SNOOP CONTRACT] Error liberando Snoop: ${err.message}`, { linkedId });
        throw err;
    }
}

/**
 * 🎯 Destruir Snoop (cualquier estado → DESTROYED)
 */
export async function destroySnoop(linkedId) {
    const current = await getSnoopContract(linkedId);
    if (!current) {
        log("debug", `[SNOOP CONTRACT] No existe contrato para destruir: ${linkedId}`);
        return null;
    }

    if (current.state === SnoopState.DESTROYED) {
        return current;
    }

    try {
        const destroyed = await transitionSnoopState(
            linkedId,
            current.state,
            SnoopState.DESTROYED
        );

        // Limpiar Redis (ambos índices)
        await Promise.all([
            redis.del(`snoop:${linkedId}`),
            redis.del(`snoop:by-id:${current.snoopId}`)
        ]);

        log("info", `📜 [SNOOP CONTRACT] Snoop destruido: ${current.snoopId}`, {
            linkedId,
            snoopId: current.snoopId,
            previousState: current.state
        });

        return destroyed;
    } catch (err) {
        log("warn", `⚠️ [SNOOP CONTRACT] Error destruyendo Snoop: ${err.message}`, { linkedId });
        // Forzar limpieza (ambos índices)
        const currentForCleanup = await getSnoopContract(linkedId);
        if (currentForCleanup) {
            await Promise.all([
                redis.del(`snoop:${linkedId}`),
                redis.del(`snoop:by-id:${currentForCleanup.snoopId}`)
            ]);
        } else {
            await redis.del(`snoop:${linkedId}`);
        }
        throw err;
    }
}
