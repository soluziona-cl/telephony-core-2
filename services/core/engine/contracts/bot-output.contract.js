// =========================================================
// BOT OUTPUT CONTRACT — Contrato Unificado para Salida del Bot
// =========================================================
// 
// PRINCIPIO ARQUITECTÓNICO:
// - WAV y TTS se tratan igual
// - El tipo de audio NO afecta el comportamiento de escucha
// - La interrupción se gobierna por interruptPolicy, no por tipo de audio
//
// =========================================================

import { log } from "../../../../lib/logger.js";
import { createInterruptPolicyFromDomainResult } from "./interrupt-policy.contract.js";

/**
 * @typedef {Object} BotOutput
 * @property {'static' | 'tts'} type - Tipo de salida de audio
 * @property {Object} payload - Payload según el tipo
 * @property {string} [payload.file] - Archivo de audio estático (si type='static')
 * @property {string} [payload.text] - Texto para TTS (si type='tts')
 * @property {string} [payload.voice] - Voz para TTS (opcional)
 * @property {Object} interruptPolicy - Política de interrupción
 */

/**
 * Normalizar resultado del dominio a BotOutput unificado
 * Compatible con formatos legacy (audio, soundFile, ttsText, text, silent, allowBargeIn)
 * 
 * @param {Object} domainResult - Resultado del dominio
 * @returns {BotOutput | null} - BotOutput normalizado o null si no hay salida
 */
export function normalizeBotOutput(domainResult) {
    if (!domainResult) return null;

    // 1. AUDIO ESTÁTICO (WAV/BVDA)
    const audioFile = domainResult.audio || domainResult.soundFile;
    if (audioFile) {
        // Remover prefijo 'sound:voicebot/' si existe
        const cleanFile = audioFile.replace(/^sound:voicebot\//, '').replace(/^voicebot\//, '');
        
        return {
            type: 'static',
            payload: {
                file: cleanFile
            },
            interruptPolicy: createInterruptPolicyFromDomainResult(domainResult)
        };
    }

    // 2. TTS (TEXT TO SPEECH)
    const ttsText = domainResult.ttsText || domainResult.text;
    if (ttsText) {
        return {
            type: 'tts',
            payload: {
                text: ttsText,
                voice: domainResult.voice || null // Voz opcional
            },
            interruptPolicy: createInterruptPolicyFromDomainResult(domainResult)
        };
    }

    // 3. NO HAY SALIDA
    return null;
}

/**
 * Obtener media path para playback (compatible con Asterisk)
 * @param {BotOutput} botOutput - BotOutput normalizado
 * @returns {string | null} - Media path o null
 */
export function getMediaPath(botOutput) {
    if (!botOutput) return null;

    if (botOutput.type === 'static') {
        return `sound:voicebot/${botOutput.payload.file}`;
    }

    // TTS se maneja diferente (requiere generación)
    return null;
}

/**
 * Verificar si BotOutput requiere generación de TTS
 * @param {BotOutput} botOutput - BotOutput normalizado
 * @returns {boolean}
 */
export function requiresTTSGeneration(botOutput) {
    return botOutput && botOutput.type === 'tts';
}

/**
 * Logging estructurado de BotOutput
 * @param {BotOutput} botOutput - BotOutput normalizado
 * @param {string} phase - Fase actual
 */
export function logBotOutput(botOutput, phase) {
    if (!botOutput) {
        log("debug", `🔇 [BOT_OUTPUT] Sin salida de audio (phase: ${phase})`);
        return;
    }

    const outputType = botOutput.type === 'static' ? 'WAV' : 'TTS';
    const outputDesc = botOutput.type === 'static' 
        ? `file: ${botOutput.payload.file}`
        : `text: "${botOutput.payload.text?.slice(0, 50)}..."`;

    log("info", `🔊 [BOT_OUTPUT] ${outputType} (phase: ${phase})`, {
        type: botOutput.type,
        description: outputDesc,
        interruptPolicy: {
            allowBargeIn: botOutput.interruptPolicy.allowBargeIn,
            minSpeechMs: botOutput.interruptPolicy.minSpeechMs,
            minConfidence: botOutput.interruptPolicy.minConfidence
        }
    });
}
