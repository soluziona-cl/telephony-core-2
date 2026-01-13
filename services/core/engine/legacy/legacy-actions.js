/**
 * LEGACY ACTION EXECUTOR
 * Handles domain actions like CALL_WEBHOOK, USE_ENGINE, SET_STATE, END_CALL.
 */

import { log } from "../../../../lib/logger.js";

export async function executeDomainAction(logicResult, businessState, ari, channel, ani, dnis, linkedId, promptFile) {
    if (!logicResult.action || !logicResult.action.type) return null;

    log("info", `[DOMAIN] Ejecutando acción: ${logicResult.action.type}`);

    let result = { shouldHangup: false, ttsText: null, nextPhase: null };

    switch (logicResult.action.type) {
        case 'USE_ENGINE':
            // Cambiar a engine con query para gestión real
            const { engine, context } = logicResult.action.payload;
            if (engine === 'WITH_QUERY') {
                log("info", `[DOMAIN] Cambiando a engine WITH_QUERY para gestión de negocio`);
                // Importar y usar engine con query
                // Nota: Ajustamos la ruta relativa asumiendo que este archivo está en services/core/engine/legacy/
                const { default: startVoiceBotSessionWithQuery } = await import('../voicebot-engine-inbound-withQuery-v0.js');

                // Transferir control al engine con query (pasa contexto si existe)
                await startVoiceBotSessionWithQuery(ari, channel, ani, dnis, linkedId, promptFile);

                // Marcar para finalizar este engine
                result.shouldHangup = true;
                result.ttsText = null;
                return result;
            }
            break;

        case 'CALL_WEBHOOK':
            // El webhook ya fue llamado por el dominio, solo aplicar resultado
            log("info", `[DOMAIN] Webhook ${logicResult.action.payload.name} ya ejecutado por dominio`);
            // Aplicar onSuccess/onError según resultado
            if (logicResult.action.payload.onSuccess) {
                result.nextPhase = logicResult.action.payload.onSuccess.nextPhase;
                result.ttsText = logicResult.action.payload.onSuccess.ttsText;
            }
            break;

        case 'SET_STATE':
            // Actualizar estado con los updates
            if (logicResult.action.payload.updates) {
                Object.assign(businessState, logicResult.action.payload.updates);
                log("info", `[DOMAIN] Estado actualizado: ${JSON.stringify(logicResult.action.payload.updates)}`);
            }
            break;

        case 'END_CALL':
            // Finalizar llamada
            log("info", `[DOMAIN] Finalizando llamada: ${logicResult.action.payload.reason || 'COMPLETE'}`);
            result.ttsText = logicResult.action.payload.ttsText || logicResult.ttsText;
            result.nextPhase = 'COMPLETE';
            result.shouldHangup = true;
            return result;

        default:
            log("warn", `[DOMAIN] Acción desconocida: ${logicResult.action.type}`);
    }

    // Fusionar resultados si no se devolvió antes
    if (result.nextPhase) logicResult.nextPhase = result.nextPhase;
    if (result.ttsText) logicResult.ttsText = result.ttsText;

    return result; // Retorna flag si debe colgar o algo extra
}
