// =========================================================
// CAPSULE CONTRACT — Validación de Contrato de Cápsula
// =========================================================
// 
// Define el contrato que TODAS las cápsulas deben cumplir
// para ser utilizadas por el engine.
//
// PRINCIPIO: Fail-fast, no degradación silenciosa
// =========================================================

import { log } from '../../../lib/logger.js';

/**
 * Contrato oficial de Cápsula v1
 * 
 * Una cápsula válida debe tener:
 * - domain: función que maneja eventos del engine
 * - domainName: string identificador (opcional pero recomendado)
 * - systemPrompt: string con el prompt del sistema (opcional)
 * - sttMode: 'realtime' | 'legacy-batch' (opcional)
 */
export const CAPSULE_CONTRACT = {
    REQUIRED: ['domain'],
    OPTIONAL: ['domainName', 'systemPrompt', 'sttMode', 'botName', 'type']
};

/**
 * Valida que una cápsula cumple el contrato esperado
 * 
 * @param {any} capsule - Objeto cápsula a validar
 * @param {string} name - Nombre de la cápsula (para logs)
 * @returns {object} - { valid: boolean, errors: string[] }
 */
export function validateCapsule(capsule, name = 'unknown') {
    const errors = [];
    
    // 1. Verificar que es un objeto
    if (!capsule || typeof capsule !== 'object') {
        errors.push(`Capsule ${name} inválida: no es un objeto (type: ${typeof capsule})`);
        return { valid: false, errors };
    }
    
    // 2. Verificar propiedades requeridas
    if (typeof capsule.domain !== 'function') {
        errors.push(`Capsule ${name} no expone función domain() (type: ${typeof capsule.domain})`);
    }
    
    // 3. Validar tipos de propiedades opcionales
    if (capsule.domainName !== undefined && typeof capsule.domainName !== 'string') {
        errors.push(`Capsule ${name} tiene domainName inválido (type: ${typeof capsule.domainName})`);
    }
    
    if (capsule.systemPrompt !== undefined && typeof capsule.systemPrompt !== 'string') {
        errors.push(`Capsule ${name} tiene systemPrompt inválido (type: ${typeof capsule.systemPrompt})`);
    }
    
    if (capsule.sttMode !== undefined && !['realtime', 'legacy-batch'].includes(capsule.sttMode)) {
        errors.push(`Capsule ${name} tiene sttMode inválido (value: ${capsule.sttMode})`);
    }
    
    const valid = errors.length === 0;
    
    if (valid) {
        log("info", `✅ [CAPSULE CONTRACT] Cápsula ${name} válida`, {
            hasDomain: typeof capsule.domain === 'function',
            domainName: capsule.domainName || 'none',
            hasSystemPrompt: typeof capsule.systemPrompt === 'string',
            sttMode: capsule.sttMode || 'none',
            botName: capsule.botName || 'none'
        });
    } else {
        log("error", `❌ [CAPSULE CONTRACT] Cápsula ${name} inválida:`, {
            errors: errors,
            capsuleType: typeof capsule,
            capsuleKeys: capsule ? Object.keys(capsule) : []
        });
    }
    
    return { valid, errors };
}

/**
 * Normaliza una cápsula a formato estándar
 * 
 * Si la cápsula es una función directa, la envuelve en un objeto estándar
 * 
 * @param {any} capsule - Cápsula a normalizar (puede ser función u objeto)
 * @param {string} name - Nombre de la cápsula
 * @returns {object|null} - Cápsula normalizada o null si es inválida
 */
export function normalizeCapsule(capsule, name = 'unknown') {
    // Si es una función directa, normalizarla a objeto
    if (typeof capsule === 'function') {
        log("info", `🔄 [CAPSULE CONTRACT] Normalizando función a objeto estándar para ${name}`);
        return {
            domain: capsule,
            domainName: capsule.domainName || name,
            systemPrompt: capsule.systemPrompt,
            sttMode: capsule.sttMode,
            botName: capsule.botName || 'Capsule',
            type: capsule.type || 'PHASED'
        };
    }
    
    // Si ya es un objeto, validarlo
    if (capsule && typeof capsule === 'object') {
        return capsule;
    }
    
    // Si no es ni función ni objeto válido
    log("error", `❌ [CAPSULE CONTRACT] No se puede normalizar cápsula ${name}: type=${typeof capsule}`);
    return null;
}

/**
 * Valida y normaliza una cápsula en un solo paso
 * 
 * @param {any} capsule - Cápsula a validar y normalizar
 * @param {string} name - Nombre de la cápsula
 * @returns {object|null} - Cápsula normalizada y validada, o null si es inválida
 */
export function validateAndNormalizeCapsule(capsule, name = 'unknown') {
    // Normalizar primero
    const normalized = normalizeCapsule(capsule, name);
    
    if (!normalized) {
        return null;
    }
    
    // Validar
    const validation = validateCapsule(normalized, name);
    
    if (!validation.valid) {
        return null;
    }
    
    return normalized;
}
