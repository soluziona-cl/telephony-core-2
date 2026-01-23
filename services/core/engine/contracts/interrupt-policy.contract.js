// =========================================================
// INTERRUPT POLICY CONTRACT — Gobernanza de Interrupción por Dominio
// =========================================================
// 
// PRINCIPIO ARQUITECTÓNICO:
// - El canal de entrada siempre escucha
// - El bot puede o no ser interrumpible
// - La decisión NO es técnica: es de dominio
//
// =========================================================

import { log } from "../../../../lib/logger.js";

/**
 * @typedef {Object} InterruptPolicy
 * @property {boolean} allowBargeIn - Si el bot puede ser interrumpido por voz del usuario
 * @property {number} [minSpeechMs] - Duración mínima de voz (ms) para considerar interrupción válida
 * @property {number} [minConfidence] - Confianza mínima de STT para considerar interrupción válida
 * @property {boolean} [ignoreIfOnlyNoise] - Ignorar si solo es ruido/tos/respiración
 */

/**
 * Política de interrupción por defecto (conservadora)
 */
const DEFAULT_INTERRUPT_POLICY = {
    allowBargeIn: false,
    minSpeechMs: 400,
    minConfidence: 0.6,
    ignoreIfOnlyNoise: true
};

/**
 * Obtener política de interrupción para un dominio y fase
 * @param {string} domainName - Nombre del dominio
 * @param {string} phase - Fase actual
 * @param {Object} domainConfig - Configuración del dominio (opcional)
 * @returns {InterruptPolicy}
 */
export function getInterruptPolicy(domainName, phase, domainConfig = {}) {
    // 🎯 PRIORIDAD 1: Política específica por fase
    if (domainConfig?.phases?.[phase]?.interruptPolicy) {
        const phasePolicy = domainConfig.phases[phase].interruptPolicy;
        log("debug", `🔒 [INTERRUPT_POLICY] Política específica de fase: ${phase}`, phasePolicy);
        return {
            ...DEFAULT_INTERRUPT_POLICY,
            ...phasePolicy
        };
    }

    // 🎯 PRIORIDAD 2: Política global del dominio
    if (domainConfig?.interruptPolicy) {
        log("debug", `🔒 [INTERRUPT_POLICY] Política global del dominio: ${domainName}`, domainConfig.interruptPolicy);
        return {
            ...DEFAULT_INTERRUPT_POLICY,
            ...domainConfig.interruptPolicy
        };
    }

    // 🎯 PRIORIDAD 3: Política por defecto
    log("debug", `🔒 [INTERRUPT_POLICY] Política por defecto (conservadora) para ${domainName}/${phase}`);
    return DEFAULT_INTERRUPT_POLICY;
}

/**
 * Evaluar si se debe interrumpir el playback basado en política e intención
 * @param {InterruptPolicy} policy - Política de interrupción
 * @param {Object} speechData - Datos de voz detectada
 * @param {number} speechData.speechMs - Duración de voz en ms
 * @param {number} speechData.confidence - Confianza de STT (0-1)
 * @param {string} speechData.text - Texto transcrito
 * @param {boolean} speechData.isNoise - Si es solo ruido
 * @returns {boolean} - true si se debe interrumpir
 */
export function shouldInterrupt(policy, speechData) {
    if (!policy.allowBargeIn) {
        return false; // Interrupción deshabilitada
    }

    // Verificar duración mínima
    if (speechData.speechMs < (policy.minSpeechMs || 400)) {
        log("debug", `🔒 [INTERRUPT_POLICY] Voz demasiado corta: ${speechData.speechMs}ms < ${policy.minSpeechMs || 400}ms`);
        return false;
    }

    // Verificar confianza mínima
    if (speechData.confidence !== undefined && speechData.confidence < (policy.minConfidence || 0.6)) {
        log("debug", `🔒 [INTERRUPT_POLICY] Confianza insuficiente: ${speechData.confidence} < ${policy.minConfidence || 0.6}`);
        return false;
    }

    // Ignorar si es solo ruido
    if (policy.ignoreIfOnlyNoise && speechData.isNoise) {
        log("debug", `🔒 [INTERRUPT_POLICY] Ignorando ruido/noise`);
        return false;
    }

    log("info", `🔒 [INTERRUPT_POLICY] ✅ Interrupción permitida: speechMs=${speechData.speechMs}, confidence=${speechData.confidence || 'N/A'}`);
    return true;
}

/**
 * Crear política de interrupción desde resultado del dominio
 * Compatible con formato legacy (allowBargeIn, silent)
 * @param {Object} domainResult - Resultado del dominio
 * @returns {InterruptPolicy}
 */
export function createInterruptPolicyFromDomainResult(domainResult) {
    // 🎯 Soporte para formato legacy
    if (domainResult.allowBargeIn !== undefined) {
        return {
            ...DEFAULT_INTERRUPT_POLICY,
            allowBargeIn: domainResult.allowBargeIn === true
        };
    }

    // 🎯 Soporte para silent (legacy)
    if (domainResult.silent === true) {
        return {
            ...DEFAULT_INTERRUPT_POLICY,
            allowBargeIn: false
        };
    }

    // 🎯 Soporte para interruptPolicy explícito
    if (domainResult.interruptPolicy) {
        return {
            ...DEFAULT_INTERRUPT_POLICY,
            ...domainResult.interruptPolicy
        };
    }

    // Por defecto, permitir interrupción (comportamiento natural)
    return {
        ...DEFAULT_INTERRUPT_POLICY,
        allowBargeIn: true
    };
}
