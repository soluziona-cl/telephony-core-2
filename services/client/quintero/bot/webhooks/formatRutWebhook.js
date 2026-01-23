// services/client/quintero/bot/webhooks/formatRutWebhook.js
import { log } from '../../../../../lib/logger.js';
import { getRutState } from '../../../../core/engine/incremental-rut-processor.js';

/**
 * 🎯 FALLA C FIX: Validación local de RUT (fallback cuando webhook falla)
 */
function validateRutLocal(text) {
    if (!text || typeof text !== 'string') {
        return { ok: false, reason: 'EMPTY_INPUT' };
    }
    
    // Extraer dígitos del texto
    const digits = text.replace(/[^0-9kK]/g, '');
    
    if (digits.length < 7) {
        return { ok: false, reason: 'INSUFFICIENT_DIGITS' };
    }
    
    // Separar cuerpo y DV
    const body = digits.slice(0, -1);
    const dv = digits.slice(-1).toUpperCase();
    
    if (body.length < 7 || body.length > 8) {
        return { ok: false, reason: 'INVALID_BODY_LENGTH' };
    }
    
    // Validar módulo 11
    let sum = 0;
    let multiplier = 2;
    for (let i = body.length - 1; i >= 0; i--) {
        sum += parseInt(body[i]) * multiplier;
        multiplier = multiplier === 7 ? 2 : multiplier + 1;
    }
    const remainder = 11 - (sum % 11);
    let calculatedDv;
    if (remainder === 11) {
        calculatedDv = '0';
    } else if (remainder === 10) {
        calculatedDv = 'K';
    } else {
        calculatedDv = remainder.toString();
    }
    
    const isValid = calculatedDv === dv;
    
    return {
        ok: isValid,
        rut: `${body}-${dv}`,
        body: body,
        dv: dv,
        reason: isValid ? null : 'DV_MISMATCH'
    };
}

/**
 * 🏭 Factory for RUT Formatting Webhook
 * @param {object} config
 * @param {string} config.url - The n8n webhook URL (Optional - fallback local si falla)
 */
export function createFormatRutWebhook({ url }) {
    return async function formatRutWebhook(text, sessionId = null) {
        // 🕒 AUDITORÍA DE TIEMPOS: Inicio del evento RUT_CAPTURE_COMMIT
        const t0 = Date.now();
        
        // 🎯 LOGGING FORENSE: Distinguir claramente entre intento, envío, respuesta y fallback
        if (url) {
            // 1️⃣ INTENTO DE INVOCACIÓN
            log('info', `📡 [WEBHOOK] Intentando invocar webhook`, {
                url,
                callId: sessionId || 'N/A',
                textPreview: text ? text.substring(0, 80) + (text.length > 80 ? '...' : '') : 'EMPTY',
                textLength: text ? text.length : 0,
                timestamp: t0
            });

            try {
                // 🎯 CONTRATO DE EVENTOS EXPLÍCITO (LEGACY-STYLE)
                // El webhook espera eventos tipados, no solo "texto suelto"
                // Evento: RUT_CAPTURE_COMMIT = "usuario terminó de hablar, validar ahora"
                // 🎯 COMPATIBILIDAD: Incluir tanto 'event' (nuevo) como 'action' (legacy) para transición
                const payload = {
                    event: 'RUT_CAPTURE_COMMIT', // Nuevo contrato explícito
                    action: 'FORMAT_RUT', // Compatibilidad con webhook actual
                    domain: 'quintero',
                    callId: sessionId || 'N/A',
                    timestamp: t0,
                    rawText: text || '',
                    rut_raw: text || '', // Compatibilidad con webhook actual
                    confidence: 0.82, // Valor por defecto (podría calcularse desde STT)
                    language: 'es-CL'
                };

                // 🕒 AUDITORÍA: Tiempo de construcción del payload
                const t1 = Date.now();
                const payloadBuildTime = t1 - t0;
                
                // 2️⃣ ENVÍO REAL DEL REQUEST HTTP
                log('info', `📤 [WEBHOOK] Enviando request HTTP a ${url}`, {
                    callId: sessionId || 'N/A',
                    payload: payload,
                    timeout: '5000ms',
                    payloadBuildTime: `${payloadBuildTime}ms`
                });

                // 🕒 AUDITORÍA: Inicio de la llamada HTTP
                const t2 = Date.now();
                
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(5000) // Timeout 5s (aumentado de 2s para webhooks remotos con DB)
                });
                
                // 🕒 AUDITORÍA: Tiempo de respuesta HTTP
                const t3 = Date.now();
                const httpTime = t3 - t2;

                // 🎯 FIX: httpTimeStatus no debe ser TIMEOUT si httpTime < 5000ms (timeout real)
                // El timeout real es 5s, pero se marcaba TIMEOUT a 2s (bug)
                // Ahora: IDEAL < 300ms, ACEPTABLE < 600ms, LENTO < 2000ms, ACEPTABLE_LENTO < 5000ms, TIMEOUT >= 5000ms
                const httpTimeStatus = httpTime <= 300 ? 'IDEAL' 
                    : httpTime <= 600 ? 'ACEPTABLE' 
                    : httpTime <= 2000 ? 'LENTO' 
                    : httpTime <= 5000 ? 'ACEPTABLE_LENTO' 
                    : 'TIMEOUT';

                // 3️⃣ RESPUESTA HTTP RECIBIDA
                log('info', `📥 [WEBHOOK] Respuesta HTTP recibida`, {
                    status: response.status,
                    statusText: response.statusText,
                    ok: response.ok,
                    callId: sessionId || 'N/A',
                    httpTime: `${httpTime}ms`,
                    httpTimeStatus: httpTimeStatus
                });

                if (response.ok) {
                    // 🕒 AUDITORÍA: Inicio del parseo
                    const t4 = Date.now();
                    const rawData = await response.json();
                    
                    // 🎯 PARSEO: n8n envuelve la respuesta en { "output": "{...json string...}" }
                    // Igual que en legacy (webhook-client.js líneas 38-50)
                    let data;
                    let parseSuccess = false;
                    
                    if (rawData.output) {
                        try {
                            data = JSON.parse(rawData.output);
                            parseSuccess = true;
                            log('debug', `📦 [WEBHOOK] Respuesta parseada desde campo 'output'`);
                        } catch (parseErr) {
                            log('error', `❌ [WEBHOOK] Error parseando output: ${parseErr.message}`, {
                                rawData,
                                callId: sessionId || 'N/A'
                            });
                            // data queda undefined, parseSuccess = false
                            // Continuará al fallback
                        }
                    } else {
                        // Fallback: si no viene en output, usar directamente
                        data = rawData;
                        parseSuccess = true;
                        log('debug', `📦 [WEBHOOK] Respuesta recibida directamente (sin campo 'output')`);
                    }
                    
                    // 🕒 AUDITORÍA: Tiempo total de parseo
                    const t5 = Date.now();
                    const parseTime = t5 - t4;
                    
                    // 🎯 CONTRATO: El webhook responde con RUT_CAPTURE_RESULT
                    // Si ok === true y rut existe → AUTORITATIVO, NO revalidar, NO fallback
                    if (parseSuccess && data && data.ok === true && data.rut) {
                        // 🕒 AUDITORÍA: Tiempo total del evento
                        const t6 = Date.now();
                        const totalTime = t6 - t0;
                        
                        log('info', `✅ [WEBHOOK] RUT_CAPTURE_RESULT válido: ${data.rut}`, {
                            rut: data.rut,
                            body: data.body,
                            dv: data.dv,
                            event: data.event || data.action || 'RUT_CAPTURE_RESULT',
                            callId: sessionId || 'N/A'
                        });
                        log('info', `🎯 [WEBHOOK] RESULTADO AUTORITATIVO - El webhook es la única fuente de verdad. NO ejecutando fallback.`, {
                            rut: data.rut,
                            callId: sessionId || 'N/A',
                            note: 'Este resultado es definitivo y no requiere validación adicional'
                        });
                        // 🕒 AUDITORÍA: Métricas de tiempo completas
                        log('info', `⏱️ [WEBHOOK][TIMING] RUT_CAPTURE_COMMIT → RUT_CAPTURE_RESULT`, {
                            callId: sessionId || 'N/A',
                            payloadBuild: `${payloadBuildTime}ms`,
                            httpRequest: `${httpTime}ms`,
                            parse: `${parseTime}ms`,
                            total: `${totalTime}ms`,
                            status: totalTime <= 600 ? 'IDEAL' : totalTime <= 2000 ? 'ACEPTABLE' : 'LENTO'
                        });
                        // 🎯 RESULTADO AUTORITATIVO: El webhook es la única fuente de verdad
                        // NO ejecutar fallback, NO revalidar, confiar completamente
                        // RETORNAR INMEDIATAMENTE - esto previene que se ejecute el fallback
                        return {
                            ok: true,
                            rut: data.rut,
                            body: data.body,
                            dv: data.dv,
                            event: data.event || data.action || 'RUT_CAPTURE_RESULT',
                            confidence: data.confidence || null,
                            timing: {
                                payloadBuild: payloadBuildTime,
                                httpRequest: httpTime,
                                parse: parseTime,
                                total: totalTime
                            }
                        };
                    } else if (parseSuccess && data) {
                        // Webhook respondió pero sin RUT válido (ok=false o sin rut)
                        log('warn', `⚠️ [WEBHOOK] RUT_CAPTURE_RESULT sin RUT válido`, {
                            data,
                            callId: sessionId || 'N/A',
                            note: 'Webhook respondió pero ok=false o sin campo rut. Continuando a fallback.'
                        });
                        // Continuar al fallback solo si realmente no hay respuesta válida
                    } else {
                        // Error de parseo o data undefined
                        log('warn', `⚠️ [WEBHOOK] No se pudo parsear respuesta del webhook`, {
                            rawData,
                            callId: sessionId || 'N/A',
                            note: 'Continuando a fallback local'
                        });
                    }
                } else {
                    // Respuesta HTTP con error (4xx, 5xx)
                    log('warn', `⚠️ [WEBHOOK] Respuesta HTTP con error ${response.status}`, {
                        status: response.status,
                        statusText: response.statusText,
                        callId: sessionId || 'N/A',
                        note: 'Continuando a fallback local'
                    });
                }
            } catch (err) {
                // 🕒 AUDITORÍA: Tiempo hasta el error
                const tError = Date.now();
                const timeToError = tError - t0;
                
                // 4️⃣ ERROR EN FETCH (timeout, network, etc.) - NO hubo respuesta HTTP
                log('warn', `⚠️ [WEBHOOK] Fetch abortado/fallido - NO hubo respuesta HTTP`, {
                    error: err.name,
                    message: err.message,
                    url,
                    callId: sessionId || 'N/A',
                    reason: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
                    timeToError: `${timeToError}ms`
                });
                // 🕒 AUDITORÍA: Métricas de error
                log('info', `⏱️ [WEBHOOK][TIMING] RUT_CAPTURE_COMMIT → ERROR`, {
                    callId: sessionId || 'N/A',
                    error: err.name,
                    timeToError: `${timeToError}ms`,
                    status: timeToError >= 2000 ? 'TIMEOUT' : 'NETWORK_ERROR'
                });
                // 🎯 REGLA: Solo ejecutar fallback si NO hubo respuesta HTTP
                // Si hubo respuesta pero fue inválida, el fallback se ejecuta después
            }
        }
        
        // 🎯 FALLBACK LOCAL: SOLO ejecutado cuando:
        // - NO hubo respuesta HTTP (timeout, network error)
        // - O hubo respuesta pero ok=false y sin rut
        // NUNCA ejecutar si el webhook respondió ok=true con rut válido
        log('info', `🔄 [WEBHOOK FALLBACK] Ejecutando validación local (webhook no invocado o falló)`, {
            callId: sessionId || 'N/A',
            reason: url ? 'WEBHOOK_NOT_REACHED' : 'NO_WEBHOOK_URL',
            note: 'Este fallback solo se ejecuta si NO hubo respuesta HTTP válida del webhook remoto'
        });
        
        // Primero intentar desde Redis (si hay sessionId)
        if (sessionId) {
            try {
                const rutState = await getRutState(sessionId);
                if (rutState && rutState.normalized && rutState.normalized.length >= 7) {
                    const normalized = rutState.normalized;
                    const body = normalized.length >= 8 ? normalized.slice(0, -1) : normalized;
                    const dv = normalized.length >= 8 ? normalized.slice(-1) : null;
                    
                    if (dv) {
                        const result = validateRutLocal(`${body}${dv}`);
                        if (result.ok) {
                            log('info', `✅ [WEBHOOK FALLBACK] RUT validado desde Redis: ${result.rut}`, {
                                rut: result.rut,
                                source: 'redis_normalized',
                                callId: sessionId
                            });
                            return result;
                        }
                    }
                }
            } catch (err) {
                log('debug', `⚠️ [WEBHOOK FALLBACK] Error obteniendo RUT desde Redis: ${err.message}`);
            }
        }
        
        // Fallback final: validar texto directamente
        const result = validateRutLocal(text);
        if (result.ok) {
            log('info', `✅ [WEBHOOK FALLBACK] RUT validado localmente: ${result.rut}`, {
                rut: result.rut,
                source: 'local_validation',
                callId: sessionId || 'N/A'
            });
        } else {
            log('warn', `⚠️ [WEBHOOK FALLBACK] RUT inválido en validación local`, {
                reason: result.reason,
                input: text ? text.substring(0, 50) + (text.length > 50 ? '...' : '') : 'EMPTY',
                callId: sessionId || 'N/A',
                note: 'Este es un código INTERNO del fallback, NO una respuesta del webhook remoto'
            });
        }
        return result;
    };
}

