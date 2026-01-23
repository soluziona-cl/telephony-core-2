// =========================================================
// VOICEBOT ENGINE V3 — MINIMAL, DETERMINISTIC, SAFE
// =========================================================

import fs from "fs";
import os from "os"; // Added for IP detection
import { log } from "../../../lib/logger.js";
import redis from "../../../lib/redis.js";
import dgram from "dgram";
import { OpenAIRealtimeClientV3 } from "./openai-client.js";
import { createIncrementalClient } from "./openai-client-incremental.js";
import { playWithBargeIn, waitForRealVoice, recordUserTurn, sendSystemTextAndPlay } from "./legacy/legacy-helpers.js";
import { parseRutFromSpeech, textToDigits } from "./utils.js";
import { CallFinalizer } from "./services/call-finalizer.js";
import { inboundConfig as config } from "./config.js";
import { savePartialRut, getPartialRut, clearPartialRut, isValidPartialRut, getConsolidatedRutText } from "./incremental-rut-processor.js";
import { createFormatRutWebhook } from "../../client/quintero/bot/webhooks/formatRutWebhook.js";
import { isActionAllowed, isResourceRequired, isTeardownAllowed, getPhaseContract, isValidPhase } from "./lifecycle-contract.js";
import {
    SnoopState,
    createSnoopContract,
    getSnoopContract,
    transitionSnoopState,
    assertSnoopReady,
    releaseSnoop,
    destroySnoop
} from "./contracts/snoop.contract.js";
import {
    getInterruptPolicy,
    shouldInterrupt,
    createInterruptPolicyFromDomainResult
} from "./contracts/interrupt-policy.contract.js";
import {
    normalizeBotOutput,
    getMediaPath,
    requiresTTSGeneration,
    logBotOutput
} from "./contracts/bot-output.contract.js";
// 🎙️ CONTINUOUS RECORDING & SEGMENTATION (Nueva arquitectura)
import { ContinuousRecorder } from "../../voice/recording/continuous-recorder.js";
import { Segmenter } from "../../voice/segmentation/segmenter.js";
import { SegmentStoreRedis } from "../../voice/segmentation/segment-store-redis.js";
import { SttQueue } from "../../voice/stt/stt-queue.js";
import { createSttWorker } from "../../voice/stt/stt-worker.js";
import { isFeatureEnabled } from "./config/features.js";
// 🎯 AUDIO MARKS — Segmentación lógica de audio continuo
import { initAudioMarks, emitAudioMark, AudioMarkType, clearAudioMarks } from "../audio/audio-marks.js";
import { resolveAudioSegments, getActiveSegment } from "../audio/audio-segments.js";
import { AudioPlaneController } from "../audio/audio-plane-controller.js";

// ✅ SESSION REGISTRY (Global Metadata Store)
export const activeSessions = new Map();

const MAX_TURNS = config.engine.maxTurns || 15;
const MAX_SILENT_TURNS = config.engine.maxSilentTurns || 3;
const MIN_AUDIO_BYTES = config.audio.minWavSizeBytes || 6000;
const POST_PLAYBACK_GUARD_MS = 400; // 🛡️ Guard time after playback before listening
const MIN_SILENCE_MS = 800; // 🛡️ Minimum silence to trigger STT (reducido de 1200ms para mejor UX)

// 🎯 PRIMITIVA AUDIO_READY — Confirmación de Asterisk (control-plane)
/**
 * Espera que Asterisk confirme que un canal de audio está realmente listo
 * para ser gobernado por el engine (Snoop en Stasis). NO requiere que ya exista RTP/audio fluyendo.
 *
 * Nota crítica: LISTEN_* puede ser silencio; "audio presente" es un evento distinto (RTP/voz).
 * AUDIO_READY aquí significa: "Snoop está vivo y dentro de la app SNOOP_APP".
 * 
 * @param {Object} ari - Cliente ARI
 * @param {string} snoopId - ID del canal Snoop
 * @param {string} linkedId - LinkedId para correlación
 * @param {number} timeoutMs - Timeout máximo (default: 3000ms)
 * @returns {Promise<void>} Resuelve cuando el canal está READY según Asterisk
 */
async function waitForAsteriskReady(ari, snoopId, linkedId, timeoutMs = 5000) {
    return new Promise(async (resolve, reject) => {
        // 🎯 PRODUCTION_TIMING: No rechazar por timeout - el Snoop puede tardar en materializarse
        // El timeout solo es un warning, no un error fatal
        // El Snoop permanecerá en WAITING_AST hasta que llegue StasisStart
        const timeout = setTimeout(() => {
            // NO hacer cleanup aquí - mantener listeners activos para eventos futuros
            log("warn", `⏱️ [AUDIO_READY] Timeout esperando Snoop ${snoopId} (continuando espera de eventos)`, { linkedId, timeoutMs });
            // 🎯 DIAGNÓSTICO: Intentar obtener estado del canal
            ari.Channel().get({ channelId: snoopId }).then(channelState => {
                log("warn", `🔍 [AUDIO_READY] Estado del canal al timeout: ${JSON.stringify({ state: channelState?.state, name: channelState?.name, dialplan: channelState?.dialplan })}`, { linkedId, snoopId });
            }).catch(() => {
                log("warn", `🔍 [AUDIO_READY] Canal ${snoopId} aún no visible en ARI (esperando StasisStart)`, { linkedId });
            });
            // 🎯 CRÍTICO: NO rechazar - resolver como "pending" para que el engine continúe
            // El Snoop seguirá en WAITING_AST y se activará cuando llegue StasisStart
            log("info", `🔄 [AUDIO_READY] Snoop ${snoopId} en modo espera pasiva - StasisStart activará readiness`, { linkedId });
            resolve(); // Resolver sin error - el contrato mantendrá WAITING_AST
        }, timeoutMs);

        let stasisReceived = false;
        const SNOOP_APP = "media-snoop";
        let pollTimer = null;
        let ariPollTimer = null;

        const checkReady = () => {
            // ✅ AUDIO_READY (control-plane): StasisStart del Snoop.
            // No exigimos state=Up: en LISTEN_* puede no haber RTP aún y algunos Asterisk no emiten ChannelStateChange.
            if (stasisReceived) {
                cleanup();
                log("info", `✅ [AUDIO_READY] Snoop ${snoopId} confirmado por Asterisk (StasisStart)`, { linkedId, snoopId });
                resolve();
            }
        };

        const cleanup = () => {
            clearTimeout(timeout);
            ari.removeListener("StasisStart", stasisHandler);
            if (pollTimer) clearInterval(pollTimer);
            if (ariPollTimer) clearTimeout(ariPollTimer); // Cambiado a clearTimeout porque ahora usamos setTimeout recursivo
        };

        const stasisHandler = (event, channel) => {
            if (event.application === SNOOP_APP && channel.id === snoopId) {
                stasisReceived = true;
                log("debug", `🔔 [AUDIO_READY] StasisStart recibido para Snoop ${snoopId}`, { linkedId });
                checkReady();
            }
        };

        // 🎯 CRÍTICO: Verificar contrato SNOOP para confirmar READY (fuente de verdad)
        // Redis es solo un indicador secundario - el contrato es la autoridad
        try {
            const { getSnoopContract, SnoopState } = await import("./contracts/snoop.contract.js");
            const contract = await getSnoopContract(linkedId);

            if (contract && contract.snoopId === snoopId) {
                if (contract.state === SnoopState.READY) {
                    // 🎯 CONTRATO CONFIRMADO: Snoop está READY
                    stasisReceived = true;
                    log("info", `✅ [AUDIO_READY] Snoop ${snoopId} confirmado por contrato (estado: ${contract.state})`, { linkedId, snoopId });
                    cleanup();
                    resolve();
                    return;
                } else {
                    log("debug", `🔍 [AUDIO_READY] Snoop ${snoopId} existe pero no está READY (estado: ${contract.state})`, { linkedId });
                }
            } else {
                log("debug", `🔍 [AUDIO_READY] Contrato no encontrado o snoopId no coincide`, { linkedId, snoopId, contractSnoopId: contract?.snoopId });
            }
        } catch (contractErr) {
            log("debug", `🔍 [AUDIO_READY] Error verificando contrato inicial: ${contractErr.message}`, { linkedId });
        }

        // 🎯 FALLBACK: Verificar Redis como indicador secundario (solo si contrato no está disponible)
        // NOTA: Redis solo se marca cuando el contrato está READY, pero no es la fuente de verdad
        const snoopActiveKey = `snoop:active:${linkedId}`;
        try {
            const active = await redis.get(snoopActiveKey);
            if (active && active === snoopId) {
                // Redis indica activo, pero verificar contrato para confirmar
                const { getSnoopContract, SnoopState } = await import("./contracts/snoop.contract.js");
                const contract = await getSnoopContract(linkedId);
                if (contract && contract.snoopId === snoopId && (contract.state === SnoopState.READY)) {
                    stasisReceived = true;
                    log("info", `✅ [AUDIO_READY] Snoop ${snoopId} confirmado por Redis + contrato READY`, { linkedId });
                    cleanup();
                    resolve();
                    return;
                } else {
                    log("debug", `🔍 [AUDIO_READY] Redis indica activo pero contrato no está READY (estado: ${contract?.state})`, { linkedId });
                }
            }
        } catch (e) {
            log("warn", `⚠️ [AUDIO_READY] Error verificando Redis inicial: ${e.message}`, { linkedId });
        }

        // 🎯 TIMING FIX: Asterisk necesita tiempo para materializar el canal Snoop
        // No hacer check inmediato - esperar 200ms antes del primer intento
        // Esto evita race conditions donde el canal aún no existe en ARI
        await new Promise(resolve => setTimeout(resolve, 200));

        // 🎯 FIX #1: Verificar ARI directo después de delay inicial
        // Esto detecta readiness incluso si los eventos no llegan
        try {
            const snoopChannel = ari.Channel();
            const channelState = await snoopChannel.get({ channelId: snoopId });
            if (channelState && channelState.state && channelState.state !== 'Down') {
                // Canal existe y está activo (Up, Ringing, etc.)
                stasisReceived = true;
                log("info", `✅ [AUDIO_READY] Snoop ${snoopId} confirmado vía ARI directo (estado: ${channelState.state})`, { linkedId, snoopId, state: channelState.state });
                cleanup();
                resolve();
                return;
            }
        } catch (e) {
            // Canal aún no existe o no está disponible - continuar con polling
            log("debug", `🔍 [AUDIO_READY] ARI check inicial (post-delay): canal ${snoopId} aún no disponible (${e.message})`, { linkedId });
        }

        // Registrar listeners para eventos futuros
        ari.on("StasisStart", stasisHandler);

        // 🎯 FIX #1: Polling ARI directo con backoff progresivo
        // Iniciar con 50ms, luego 100ms, luego 200ms para reducir carga
        let pollCount = 0;
        const pollAri = async () => {
            pollCount++;
            // Backoff progresivo: 50ms x 10, luego 100ms x 10, luego 200ms
            let currentInterval = 50;
            if (pollCount > 10 && pollCount <= 20) {
                currentInterval = 100;
            } else if (pollCount > 20) {
                currentInterval = 200;
            }

            try {
                const snoopChannel = ari.Channel();
                const channelState = await snoopChannel.get({ channelId: snoopId });
                if (channelState && channelState.state && channelState.state !== 'Down') {
                    stasisReceived = true;
                    log("debug", `🔔 [AUDIO_READY] Snoop ${snoopId} detectado vía ARI polling (estado: ${channelState.state}, intento ${pollCount})`, { linkedId });
                    checkReady();
                    return; // No continuar polling si ya está ready
                }
            } catch (e) {
                // Canal aún no existe - continuar esperando
            }

            // Continuar polling con intervalo actual
            if (!stasisReceived && pollCount < 50) { // Max 50 intentos (~5-10 segundos total)
                ariPollTimer = setTimeout(pollAri, currentInterval);
            }
        };

        // Iniciar polling después de delay inicial
        ariPollTimer = setTimeout(pollAri, 50);

        // Fallback autoritativo: el ari-listener marca snoop activo en Redis al recibir StasisStart del Snoop.
        // Esto cubre el caso donde StasisStart llegó después de la verificación inicial pero antes de registrar el listener.
        // Polling más agresivo (25ms) para reducir latencia
        pollTimer = setInterval(async () => {
            try {
                const active = await redis.get(snoopActiveKey);
                if (active && active === snoopId) {
                    stasisReceived = true;
                    log("debug", `🔔 [AUDIO_READY] Snoop ${snoopId} detectado en Redis (polling)`, { linkedId });
                    checkReady();
                }
            } catch (e) {
                // ignore
            }
        }, 25);
    });
}

// 🎯 MEJORAS WEBHOOK: Configuración de optimizaciones
const WEBHOOK_DEBOUNCE_MS = 900; // ⏱️ Debounce temporal para detectar estabilidad (aumentado de 200ms para evitar disparos prematuros)
const EMPTY_EVENTS_THRESHOLD = 2; // 🔢 Contador de eventos vacíos para early trigger (Propuesta A)
const MIN_DELTA_SIZE_BYTES = 50; // 📦 Tamaño mínimo para considerar delta como "válido" (no vacío)


export async function startVoiceBotSessionV3(
    ari,
    channel,
    ani,
    dnis,
    linkedId,
    promptFile,
    domainContext // OBLIGATORIO
) {
    // 🛡️ VALIDACIÓN CRÍTICA: Verificar que domainContext existe
    if (!domainContext) {
        log("error", `❌ [ENGINE] domainContext es OBLIGATORIO pero no fue proporcionado`);
        throw new Error("domainContext is required but was not provided");
    }

    if (!domainContext.domain || typeof domainContext.domain !== 'function') {
        log("error", `❌ [ENGINE] domainContext.domain debe ser una función pero es: ${typeof domainContext.domain}`);
        throw new Error("domainContext.domain must be a function");
    }

    log("info", `🤖 [ENGINE V3] Session start ${linkedId}`, {
        domainContextProvided: !!domainContext,
        domainFunctionExists: typeof domainContext.domain === 'function',
        domainName: domainContext.domainName || 'unknown'
    });

    // 🎯 PASO 2: SETEAR FASE INICIAL desde el engine (NO depende del dominio)
    // Esto garantiza que el lifecycle nunca vea NULL
    const INITIAL_PHASE = 'START_GREETING';
    await redis.set(`phase:${linkedId}`, INITIAL_PHASE, { EX: 3600 });
    log("info", `🔒 [LIFECYCLE] Fase inicial seteada por engine: ${INITIAL_PHASE} (linkedId=${linkedId})`);

    // ARI App name (used for ExternalMedia StasisStart)
    const ARI_APP = process.env.ARI_APP || process.env.ARI_APP_NAME || "crm_app";

    // ✅ REGISTER SESSION METADATA
    const sessionMeta = {
        ani,
        dnis,
        linkedId,
        domain: domainContext.domainName || 'unknown',
        startTime: new Date(),
        channelId: channel.id
    };
    activeSessions.set(linkedId, sessionMeta);
    activeSessions.set(channel.id, sessionMeta);

    // 🎯 AUDIO MARKS: Inicializar sistema de marcas de audio para segmentación lógica
    const audioCtx = { linkedId };
    initAudioMarks(audioCtx);
    await emitAudioMark(audioCtx, {
        type: AudioMarkType.RECORDING_START,
        reason: "call_start"
    }, log, redis);

    // ⛔ FAIL-CLOSED: DNIS and Domain Check
    if (!dnis || dnis === 'UNKNOWN' || dnis === 's') {
        log("fatal", `⛔ [ENGINE] CRITICAL: Session Aborted - Missing DNIS`, {
            linkedId, dnis, ani
        });
        await channel.hangup();
        return;
    }




    const engineState = {
        active: true,
        turn: 0,
        silentCount: 0,
        skipInput: false, // ✅ New Flag for Silent Loop
        lastPhase: null   // ✅ Track phase changes for Silent Turn fix
    };

    // 🕵️‍♂️ DETECT STT MODE
    // Options: 'realtime' (default), 'legacy-batch' (UDP buffer -> Whisper)
    const sttMode = domainContext.sttMode || config.engine.sttMode || 'realtime';
    log("info", `🎙️ [ENGINE] STT Mode: ${sttMode}`);

    // 📼 LEGACY AUDIO BUFFER
    const legacyAudioBuffer = [];

    const conversationState = {
        history: [],
        terminated: false,
        startTime: new Date(),
        linkedId,
        ani,
        dnis,
        domain: domainContext.domainName || 'unknown'
    };

    // Ensure domain state is initialized
    domainContext.state = domainContext.state || {};

    // 🎯 INCREMENTAL: Siempre usar cliente incremental (puede activarse/desactivarse dinámicamente)
    // Esto permite alternar entre modo incremental y estándar según la fase
    const openaiClient = createIncrementalClient({
        voice: config.openai.voice,
        language: config.openai.language,
        model: config.openai.model,
        instructions: domainContext.systemPrompt
    }, linkedId);

    // 🌊 UDP STREAM & STT RESOURCES (LAZY INIT)
    let udpServer = null;
    let udpPort = null;
    let externalChannel = null;
    let captureBridge = null;
    let sttInitialized = false;
    let sttInitializing = false; // 🎯 Singleton Lock: Previene ejecución concurrente de ensureSTT
    let sttInitAttempted = false; // 🎯 Gating: solo un intento por fase LISTEN_RUT
    let sttPhaseInitialized = null; // 🎯 Track en qué fase se inicializó el STT
    let snoopChannelId = null; // 🎯 Track del Snoop para protegerlo durante LISTEN_RUT
    let sttLastInitAttemptAt = 0; // 🎯 Guard temporal anti-loop STT

    // 🎤 VOICE BRIDGE (para playback audible) - referencia mutable para pasar a funciones
    const voiceBridgeRef = { current: null };

    // 🎙️ CONTINUOUS RECORDING & SEGMENTATION (Nueva arquitectura con marcas)
    let segmenter = null;
    let continuousRecorder = null;
    let sttQueue = null;
    let segmentStore = null;

    // 🧊 RUT CAPTURE FREEZE: Estado para congelar captura al primer completed
    let rutCaptureFrozen = false;
    let rutFirstCompletedAt = 0;
    let periodicCommitIntervalRef = null; // Referencia para poder detener desde callbacks

    // Verificar feature flag por dominio
    const domainName = domainContext.domainName || 'default';
    let USE_SEGMENTED_STT = isFeatureEnabled(domainName, 'SEGMENTED_CONTINUOUS_STT');

    if (USE_SEGMENTED_STT) {
        log("info", `🎙️ [ENGINE] SEGMENTED_CONTINUOUS_STT habilitado para dominio: ${domainName}`);

        try {
            // Inicializar componentes
            segmentStore = new SegmentStoreRedis({ redis });
            sttQueue = new SttQueue({ logger: log });

            // Crear worker de STT
            const sttWorker = createSttWorker({
                logger: log,
                getRecordingPathByCallId: async (callId) => {
                    const meta = await segmentStore.getRecMeta(callId);
                    return meta?.recordingPath || null;
                },
                onTranscript: async ({ segment, text }) => {
                    // Procesar transcript como si fuera un TURN normal
                    log("info", `📥 [STT_BATCH] Transcript recibido para segmento ${segment.segId}`, {
                        phase: segment.phase,
                        transcript: text.slice(0, 100)
                    });

                    // Guardar transcript en el segmento
                    const segments = await segmentStore.getSegments(callId);
                    const segIndex = segments.findIndex(s => s.segId === segment.segId);
                    if (segIndex >= 0) {
                        segments[segIndex].stt = { status: 'completed', transcript: text };
                        // Actualizar en Redis (simplificado - en producción usar lSet)
                    }

                    // Procesar transcript en el dominio (si estamos en la fase correcta)
                    const currentPhase = await redis.get(`phase:${linkedId}`) || domainContext.state?.rutPhase;
                    if (currentPhase === segment.phase) {
                        const ctx = buildDomainCtx(text, domainContext, ari, channel, ani, dnis, linkedId);
                        const domainResult = await domainContext.domain({
                            ...ctx,
                            event: 'TURN',
                            source: 'stt_batch',
                            segment: segment
                        });

                        if (domainResult) {
                            await applyDomainResult(domainResult, openaiClient, conversationState, ari, channel, captureBridge, voiceBridgeRef, domainContext);
                        }
                    }
                }
            });

            // Iniciar cola
            sttQueue.start(sttWorker);

            // Inicializar recorder continuo
            continuousRecorder = new ContinuousRecorder({
                ari,
                recordingsDir: "/opt/telephony-core/recordings"
            });

        } catch (err) {
            log("error", `❌ [ENGINE] Error inicializando SEGMENTED_STT: ${err.message}`);
            USE_SEGMENTED_STT = false; // Fallback a modo normal
        }
    }

    // 🎯 FUNCIÓN REUTILIZABLE: Invocar webhook de RUT
    // Extraída para poder ser llamada desde múltiples puntos (debounce, onSilence, etc.)
    // IMPORTANTE: Definida en scope de función principal para estar disponible en todo el flujo
    const invokeRutWebhook = async (callKey, triggerReason = 'unknown', options = {}) => {
        const { playBackgroundAudio = false, stopBackgroundAudio = null } = options;
        try {
            // Obtener texto consolidado
            const tConsolidateStart = Date.now();
            const consolidatedText = await getConsolidatedRutText(callKey);
            const tConsolidateEnd = Date.now();
            const consolidateTime = tConsolidateEnd - tConsolidateStart;

            if (!consolidatedText || consolidatedText.trim().length === 0) {
                log("debug", `⏭️ [ENGINE] No hay texto consolidado para webhook (trigger: ${triggerReason})`);
                return false;
            }

            const MIN_LENGTH = 3;
            const trimmedText = consolidatedText.trim();

            if (trimmedText.length < MIN_LENGTH) {
                log("debug", `⏭️ [ENGINE] Texto consolidado muy corto (${trimmedText.length} chars) - omitiendo webhook`);
                return false;
            }

            // 🎯 FILTRO SEMÁNTICO PRE-WEBHOOK: Detectar texto que NO es candidato a RUT
            // Evitar llamadas HTTP innecesarias cuando el usuario dice números cardinales u otro texto no-RUT
            // 🎯 MEJORA CRÍTICA: Intentar parsear primero - solo rechazar si parseRutFromSpeech falla
            const semanticFilter = (text) => {
                const lowerText = text.toLowerCase();

                // 🎯 PASO 0: Intentar parsear con parseRutFromSpeech PRIMERO
                // Si parseRutFromSpeech puede extraer un body válido (aunque falte DV), permitir pasar
                // El webhook puede calcular el DV o pedirlo al usuario
                try {
                    const parsed = parseRutFromSpeech(text);
                    if (parsed && parsed.body && parsed.body >= 100000 && parsed.body <= 99999999) {
                        // Body válido encontrado (7-8 dígitos) - permitir pasar aunque falte DV
                        if (parsed.ok && parsed.rut) {
                            log("info", `🔍 [ENGINE] Filtro semántico: parseRutFromSpeech extrajo RUT válido: ${parsed.rut} - PERMITIENDO`);
                            return { isValid: true, parsedRut: parsed.rut };
                        } else {
                            log("info", `🔍 [ENGINE] Filtro semántico: parseRutFromSpeech extrajo body válido: ${parsed.body} (reason: ${parsed.reason}) - PERMITIENDO (webhook calculará DV)`);
                            return { isValid: true, parsedBody: parsed.body, parsedReason: parsed.reason };
                        }
                    }
                } catch (e) {
                    log("debug", `🔍 [ENGINE] Filtro semántico: parseRutFromSpeech falló: ${e.message}`);
                }

                // 🎯 GATE DURO: Si parseRutFromSpeech falló, validar que el texto sea normalizable a dígitos
                // Esto previene que basura STT (como "Inyowesi", "ahora sí", etc.) llegue al webhook
                try {
                    // Intentar normalizar texto a dígitos usando textToDigits
                    const normalizedDigits = textToDigits(text);
                    const digitsOnly = normalizedDigits.replace(/[^0-9Kk]/g, '');

                    // Gate 1: Debe poder normalizarse a algo que contenga dígitos
                    if (!digitsOnly || digitsOnly.length === 0) {
                        log("info", `🔍 [ENGINE] Filtro semántico: Texto no normalizable a dígitos ("${text.substring(0, 30)}...") - NO es candidato a RUT`);
                        return { isValid: false, reason: 'NOT_NORMALIZABLE_TO_DIGITS' };
                    }

                    // Gate 2: Debe tener longitud mínima de RUT (7-9 caracteres)
                    if (digitsOnly.length < 7 || digitsOnly.length > 9) {
                        log("info", `🔍 [ENGINE] Filtro semántico: Texto normalizado tiene ${digitsOnly.length} dígitos (RUT requiere 7-9) - NO es candidato a RUT`);
                        return { isValid: false, reason: 'INSUFFICIENT_DIGITS_AFTER_NORMALIZATION' };
                    }

                    // Gate 3: Verificar que el texto original contenga principalmente elementos numéricos
                    // Contar dígitos directos en el texto original
                    const directDigits = (text.match(/\d/g) || []).length;
                    // Contar palabras numéricas conocidas
                    const numericWords = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
                        'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'veinte', 'treinta', 'cuarenta',
                        'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa', 'cien', 'ciento',
                        'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos',
                        'setecientos', 'ochocientos', 'novecientos', 'millon', 'millones', 'mil', 'k', 'ka'];
                    const lowerText = text.toLowerCase();
                    const hasNumericWords = numericWords.some(word => lowerText.includes(word));

                    // Si no tiene dígitos directos NI palabras numéricas, es basura
                    if (directDigits === 0 && !hasNumericWords) {
                        log("info", `🔍 [ENGINE] Filtro semántico: Texto sin dígitos ni palabras numéricas ("${text.substring(0, 30)}...") - NO es candidato a RUT`);
                        return { isValid: false, reason: 'NO_NUMERIC_CONTENT' };
                    }
                } catch (e) {
                    log("debug", `🔍 [ENGINE] Filtro semántico: Error en normalización: ${e.message}`);
                    // Si falla la normalización, rechazar por seguridad
                    return { isValid: false, reason: 'NORMALIZATION_ERROR' };
                }

                // 🎯 NOTA: NO rechazar por palabras cardinales aquí
                // Si parseRutFromSpeech falló pero textToDigits pudo normalizar a 7-9 dígitos,
                // el texto es numéricamente válido y debe pasar al webhook para validación final
                // Las palabras cardinales (millones, mil) son PARTE de cómo se dicen los RUTs en voz

                // 🎯 MEJORA: Detectar frases comunes de confusión
                const confusionPhrases = [
                    'cuánto es', 'cuánto vale', 'cuánto cuesta', 'cuánto sale',  // Preguntas de precio
                    'número de', 'número del', 'número de la', 'número del teléfono',  // Referencias a otros números
                    'teléfono', 'celular', 'móvil', 'fijo',  // Números telefónicos
                    'dirección', 'calle', 'avenida', 'comuna',  // Direcciones
                    'código', 'clave', 'pin', 'contraseña',  // Códigos
                    'fecha', 'año', 'mes', 'día', 'hora'  // Fechas
                ];
                const hasConfusionPhrase = confusionPhrases.some(phrase => lowerText.includes(phrase));

                if (hasConfusionPhrase) {
                    const matchedPhrase = confusionPhrases.find(p => lowerText.includes(p));
                    log("info", `🔍 [ENGINE] Filtro semántico: Texto contiene frase de confusión (${matchedPhrase}) - NO es candidato a RUT`);
                    return { isValid: false, reason: 'CONFUSION_PHRASE' };
                }

                // 2. Contar dígitos potenciales (RUT chileno tiene 7-9 dígitos + DV)
                const digitCount = (text.match(/\d/g) || []).length;
                const hasValidDigitCount = digitCount >= 7 && digitCount <= 10;

                // 🎯 MEJORA: Validar formato RUT antes de contar dígitos
                // RUT válido: 7-8 dígitos + guion opcional + 1 dígito/k
                const textWithoutSpaces = text.replace(/\s/g, '');
                const rutPattern = /^[0-9]{7,8}[-]?[0-9kK]$/;
                const hasRutFormat = rutPattern.test(textWithoutSpaces);

                if (digitCount >= 7 && digitCount <= 10 && !hasRutFormat) {
                    // Tiene dígitos pero no tiene formato de RUT (ej: "1234567890" sin guion o DV)
                    const hasDigitSequence = /\d{4,}/.test(text);
                    if (!hasDigitSequence) {
                        log("info", `🔍 [ENGINE] Filtro semántico: Texto tiene dígitos pero formato RUT inválido (sin secuencia suficiente) - NO es candidato a RUT`);
                        return { isValid: false, reason: 'INVALID_RUT_FORMAT_PATTERN' };
                    }
                }

                if (!hasValidDigitCount && digitCount > 0) {
                    log("info", `🔍 [ENGINE] Filtro semántico: Texto tiene ${digitCount} dígitos (RUT requiere 7-10) - NO es candidato a RUT`);
                    return { isValid: false, reason: 'INSUFFICIENT_DIGITS' };
                }

                // 3. Verificar patrón básico: debe tener al menos algunos dígitos consecutivos
                const hasDigitSequence = /\d{4,}/.test(text);

                if (!hasDigitSequence && digitCount > 0) {
                    log("info", `🔍 [ENGINE] Filtro semántico: Texto no tiene secuencia de dígitos suficiente (mínimo 4 consecutivos) - NO es candidato a RUT`);
                    return { isValid: false, reason: 'NO_DIGIT_SEQUENCE' };
                }

                // 4. Si no tiene dígitos y es muy largo, probablemente es texto libre
                if (digitCount === 0 && text.length > 15) {
                    log("info", `🔍 [ENGINE] Filtro semántico: Texto largo sin dígitos (${text.length} chars) - NO es candidato a RUT`);
                    return { isValid: false, reason: 'TEXT_WITHOUT_DIGITS' };
                }

                return { isValid: true };
            };

            const semanticCheck = semanticFilter(trimmedText);
            if (!semanticCheck.isValid) {
                // Guardar resultado en Redis para que el dominio pueda re-promptear
                const webhookRejectKey = `rut:webhook:rejected:${callKey}`;
                await redis.set(webhookRejectKey, JSON.stringify({
                    ok: false,
                    action: 'FORMAT_RUT',
                    reason: semanticCheck.reason,
                    text: trimmedText,
                    timestamp: Date.now()
                }), { EX: 30 });

                // 🎯 MEJORA: Emitir evento de rechazo semántico
                const emitEvent = async (eventType, data) => {
                    const event = {
                        type: eventType,
                        timestamp: Date.now(),
                        callKey: callKey,
                        ...data
                    };
                    await redis.lPush(`events:${eventType}`, JSON.stringify(event));
                    await redis.expire(`events:${eventType}`, 86400);
                };

                await emitEvent('RUT_SEMANTIC_REJECT', {
                    reason: semanticCheck.reason,
                    textPreview: trimmedText.substring(0, 20),
                    textLength: trimmedText.length
                });

                log("info", `⏭️ [ENGINE] Filtro semántico rechazó texto: "${trimmedText.substring(0, 50)}..." (reason: ${semanticCheck.reason}) - Omitiendo webhook`);
                return false;
            }

            // Verificar estado de negocio
            const deltaStateKey = `voicebot:quintero:${callKey}:rut:deltaState`;
            const deltaStateRaw = await redis.get(deltaStateKey);
            let deltaState = null;

            if (deltaStateRaw) {
                try {
                    deltaState = JSON.parse(deltaStateRaw);
                } catch (e) {
                    log("warn", `⚠️ [ENGINE] Error parseando deltaState: ${e.message}`);
                }
            }

            // 🎯 CRÍTICO: Definir currentTriggerReason al inicio para que esté disponible en todo el scope
            const currentTriggerReason = deltaState?.triggerReason || triggerReason;

            // Ignorar si solo streaming activo
            if (deltaState && deltaState.deltaOnly === true && deltaState.businessReady === false) {
                log("debug", `⏭️ [ENGINE] Estado deltaOnly=true, businessReady=false → Ignorando webhook (streaming activo)`);
                return false;
            }

            // 🎯 IDEMPOTENCIA: Verificar hash del texto para evitar duplicados
            const crypto = await import('crypto');
            const textHash = crypto.createHash('sha256').update(trimmedText).digest('hex').substring(0, 16);
            const webhookHashKey = `rut:webhook:hash:${callKey}`;
            const lastHash = await redis.get(webhookHashKey);

            // Verificar si ya se envió
            const webhookSentKey = `rut:webhook:sent:${callKey}`;
            const webhookStateKey = `rut:webhook:state:${callKey}`;
            const alreadySent = await redis.get(webhookSentKey);
            const webhookStateRaw = await redis.get(webhookStateKey);
            let webhookState = null;

            if (webhookStateRaw) {
                try {
                    webhookState = JSON.parse(webhookStateRaw);
                } catch (e) {
                    // Ignorar error de parseo
                }
            }

            // 🎯 IDEMPOTENCIA: Si el hash es igual al último enviado, omitir
            if (lastHash === textHash && alreadySent === 'true') {
                log("debug", `🔒 [ENGINE] Webhook ya fue enviado con el mismo texto (hash=${textHash.substring(0, 8)}...) - omitiendo duplicado`);
                return false;
            }

            // Circuit breaker mejorado - permitir upgrade
            if (alreadySent === 'true') {

                if (webhookState && webhookState.triggerReason === 'early-stable-state' &&
                    (currentTriggerReason === 'audio-settled' || deltaState?.businessReady === true)) {
                    log("info", `🔄 [ENGINE] Upgrade webhook: early-stable-state → ${currentTriggerReason} con mejor data`);
                    // Continuar para hacer upgrade
                } else if (lastHash !== textHash) {
                    // Permitir si el texto es diferente (hash diferente)
                    log("info", `🔄 [ENGINE] Texto diferente detectado (hash anterior=${lastHash?.substring(0, 8) || 'none'}, nuevo=${textHash.substring(0, 8)}) - permitiendo reenvío`);
                } else {
                    log("debug", `🔒 [ENGINE] Webhook ya fue llamado para ${callKey}, omitiendo reenvío`);
                    return false;
                }
            }

            // 🎯 CRÍTICO PARA LISTEN_RUT: Si viene de completed, saltar gate de silencio
            const skipSilenceGate = options?.skipSilenceGate === true;
            // callKey puede ser linkedId o sessionId, usar callKey directamente
            const currentPhase = await redis.get(`phase:${callKey}`) || await redis.get(`phase:${linkedId}`) || 'UNKNOWN';
            const isListenRutPhase = currentPhase === 'LISTEN_RUT';

            // 🎯 CRÍTICO: Definir now y silenceDuration antes del bloque condicional para que estén disponibles en todo el scope
            const now = Date.now();
            const lastSpeechTsKey = `voicebot:quintero:${callKey}:rut:lastSpeechTs`;
            const lastSpeechTs = await redis.get(lastSpeechTsKey);
            const silenceDuration = lastSpeechTs ? (now - parseInt(lastSpeechTs, 10)) : 0;

            // Para LISTEN_RUT con completed, procesar inmediatamente
            if (skipSilenceGate || (isListenRutPhase && triggerReason === 'transcription-completed')) {
                log("info", `🎯 [ENGINE] Saltando gate de silencio para LISTEN_RUT (trigger=${triggerReason}, phase=${currentPhase})`);
            } else {
                // Verificar tiempo de silencio (solo si NO es LISTEN_RUT con completed)

                // currentTriggerReason ya está definido arriba
                const minSilenceRequired = currentTriggerReason === 'early-stable-state' ? MIN_SILENCE_MS * 0.5 : MIN_SILENCE_MS;

                // Para triggers de debounce/stream-stable, ser más permisivo con el silencio
                if (currentTriggerReason === 'audio-settled' || currentTriggerReason === 'stream-stable') {
                    // Permitir webhook si hay al menos el tiempo de debounce (ya pasó el debounce)
                    const minDebounceSilence = Math.max(200, WEBHOOK_DEBOUNCE_MS * 0.8); // 80% del debounce como mínimo
                    if (silenceDuration < minDebounceSilence && currentTriggerReason !== 'early-stable-state') {
                        log("debug", `⏭️ [ENGINE] Silencio insuficiente para ${currentTriggerReason} (${silenceDuration}ms < ${minDebounceSilence}ms) - diferiendo webhook`);
                        return false;
                    }
                } else if (silenceDuration < minSilenceRequired && currentTriggerReason !== 'early-stable-state') {
                    log("debug", `⏭️ [ENGINE] Silencio insuficiente (${silenceDuration}ms < ${minSilenceRequired}ms) - diferiendo webhook`);
                    return false;
                }
            }

            // 🎯 URL REAL: Usar variable de entorno
            const WEBHOOK_URL = process.env.RUT_WEBHOOK_URL || process.env.RUT_FORMAT_WEBHOOK_URL;

            if (!WEBHOOK_URL) {
                log("error", `❌ [ENGINE] RUT_WEBHOOK_URL no definido - no se puede llamar al webhook`);
                return false;
            }

            const formatRutWebhook = createFormatRutWebhook({ url: WEBHOOK_URL });

            // 🎯 REPRODUCIR AUDIO DE FONDO durante la espera del webhook (si está habilitado)
            let backgroundPlayback = null;
            let stopBackgroundAudioFunc = null;

            if (playBackgroundAudio) {
                try {
                    log("info", `🔊 [ENGINE] Reproduciendo audio de fondo durante espera del webhook: queue-holdtime`);
                    const playback = ari.Playback();
                    const media = "sound:queue-holdtime";

                    // Iniciar reproducción
                    await channel.play({ media: media }, playback);
                    backgroundPlayback = playback;

                    // Función para detener el audio
                    stopBackgroundAudioFunc = async () => {
                        if (backgroundPlayback) {
                            try {
                                await backgroundPlayback.stop();
                                log("info", `🔇 [ENGINE] Audio de fondo detenido`);
                            } catch (err) {
                                log("warn", `⚠️ [ENGINE] Error deteniendo audio de fondo: ${err.message}`);
                            }
                            backgroundPlayback = null;
                        }
                    };

                    // Timeout de seguridad: detener audio después de 10 segundos
                    setTimeout(() => {
                        if (backgroundPlayback) {
                            stopBackgroundAudioFunc().catch(() => { });
                        }
                    }, 10000);
                } catch (err) {
                    log("warn", `⚠️ [ENGINE] Error iniciando audio de fondo: ${err.message}`);
                }
            }

            // Marcar como enviado ANTES del await
            const setResult = await redis.set(webhookSentKey, 'true', { EX: 60, NX: true });

            // 🎯 IDEMPOTENCIA: Guardar hash del texto enviado
            await redis.set(webhookHashKey, textHash, { EX: 60 });

            // Guardar estado del webhook
            await redis.set(webhookStateKey, JSON.stringify({
                sent: true,
                triggerReason: currentTriggerReason,
                timestamp: now,
                text: trimmedText,
                textHash: textHash,
                silenceDuration: silenceDuration
            }), { EX: 60 });

            if (setResult === null && currentTriggerReason !== 'early-stable-state') {
                log("debug", `🔒 [ENGINE] Webhook ya fue marcado como enviado, omitiendo`);
                return false;
            }

            // 🎯 MEJORA: Eventos estructurados para análisis (definir antes de usar)
            const emitEvent = async (eventType, data) => {
                const event = {
                    type: eventType,
                    timestamp: Date.now(),
                    callKey: callKey,
                    ...data
                };

                // Guardar en Redis para procesamiento batch
                await redis.lPush(`events:${eventType}`, JSON.stringify(event));
                await redis.expire(`events:${eventType}`, 86400); // 24h
            };

            // Llamar al webhook
            const tWebhookStart = Date.now();
            const invokeStart = Date.now();
            log("info", `🌐 [ENGINE] ${currentTriggerReason === 'early-stable-state' ? '🚨 EARLY TRIGGER: ' : ''}Llamando webhook con texto: "${trimmedText}" (trigger: ${currentTriggerReason})`, {
                silenceDuration: `${silenceDuration}ms`,
                consolidateTime: `${consolidateTime}ms`,
                triggerReason: currentTriggerReason
            });

            const webhookResult = await formatRutWebhook(trimmedText, callKey);
            const tWebhookEnd = Date.now();
            const webhookTotalTime = tWebhookEnd - tWebhookStart;

            // 🎯 MEJORA: Métricas de performance completas
            const webhookTiming = {
                semanticFilterTime: consolidateTime, // Ya calculado arriba
                webhookCallTime: webhookTotalTime,
                totalTime: Date.now() - invokeStart,
                silenceDuration: silenceDuration,
                triggerReason: currentTriggerReason
            };

            // Guardar en Redis para análisis
            await redis.lPush(`metrics:webhook:timing:${callKey}`, JSON.stringify(webhookTiming));
            await redis.expire(`metrics:webhook:timing:${callKey}`, 3600);

            // Emitir evento de webhook invocado
            await emitEvent('RUT_WEBHOOK_INVOKED', {
                triggerReason: currentTriggerReason,
                textLength: trimmedText.length,
                textPreview: trimmedText.substring(0, 20),
                timing: webhookTiming
            });

            // 🎯 CIERRE DURO: Siempre cerrar escucha después de webhook (éxito o fallo)
            // Esto previene contaminación del buffer con ruido post-commit
            try {
                // 🎯 PASO 1: Congelar identidad ANTES de procesar respuesta
                // Esto bloquea cualquier delta que llegue después
                const frozenKey = `id:RUT:frozen:${callKey}`;
                await redis.set(frozenKey, 'true', { EX: 60 });
                log("info", `🔒 [ENGINE] Buffer RUT congelado para ${callKey} (cierre duro)`);

                // 🎯 PASO 2: Desactivar incremental STT
                if (openaiClient && openaiClient.disableIncremental) {
                    if (openaiClient.isIncrementalEnabled && openaiClient.isIncrementalEnabled()) {
                        log("info", `🔒 [ENGINE] Cerrando STT incremental tras webhook (evitar captura post-RUT)`);
                        openaiClient.disableIncremental();
                    }
                }

                // 🎯 PASO 3: Limpiar estado de tracking
                await redis.del(deltaStateKey);

                // 🎯 PASO 4: Limpiar tokens acumulados (ya no son necesarios)
                // El transcript completo ya está guardado en partial, los tokens son redundantes
                const tokensKey = `id:RUT:tokens:${callKey}`;
                await redis.del(tokensKey);

            } catch (err) {
                log("warn", `⚠️ [ENGINE] Error en cierre duro de escucha: ${err.message}`);
            }

            // Procesar resultado del webhook
            if (webhookResult && webhookResult.ok) {
                log("info", `✅ [ENGINE] Webhook validó RUT: ${webhookResult.rut}`, {
                    webhookTime: `${webhookTotalTime}ms`,
                    triggerReason: currentTriggerReason
                });
                await redis.set(`rut:validated:${callKey}`, JSON.stringify(webhookResult), { EX: 60 });

                // 🎯 MEJORA: Emitir evento de éxito
                await emitEvent('RUT_WEBHOOK_SUCCESS', {
                    rut: webhookResult.rut,
                    timing: webhookTiming
                });

                // 🎯 AUDIO MARKS: Marcar intención finalizada (RUT válido)
                await emitAudioMark(audioCtx, {
                    type: AudioMarkType.INTENT_FINALIZED,
                    reason: "rut_valid",
                    meta: { rut: webhookResult.rut, callKey, webhookTime: webhookTotalTime }
                }, log, redis);

                // 🎯 Resolver segmentos y loguear
                const segments = resolveAudioSegments(audioCtx.audioMarks || []);
                if (segments.length > 0) {
                    const lastSegment = segments[segments.length - 1];
                    log("info", "[AUDIO_SEGMENTS_RESOLVED]", {
                        linkedId: audioCtx.linkedId,
                        segments: segments,
                        lastSegment: lastSegment
                    });
                }
            } else {
                log("warn", `⚠️ [ENGINE] Webhook rechazó RUT: ${webhookResult?.reason || 'unknown'}`, {
                    webhookTime: `${webhookTotalTime}ms`,
                    triggerReason: currentTriggerReason
                });
                await redis.set(`rut:validated:${callKey}`, JSON.stringify(webhookResult), { EX: 60 });

                // 🎯 MEJORA: Emitir evento de rechazo
                await emitEvent('RUT_WEBHOOK_REJECTED', {
                    reason: webhookResult?.reason || 'unknown',
                    timing: webhookTiming
                });
            }

            // 🎯 DETENER AUDIO DE FONDO si estaba reproduciéndose
            if (stopBackgroundAudioFunc) {
                try {
                    await stopBackgroundAudioFunc();
                    log("info", `🔇 [ENGINE] Audio de fondo detenido tras respuesta del webhook`);
                } catch (err) {
                    log("warn", `⚠️ [ENGINE] Error deteniendo audio de fondo: ${err.message}`);
                }
            }

            return true;
        } catch (error) {
            log("error", `❌ [ENGINE] Error invocando webhook: ${error.message}`, { triggerReason });

            // Detener audio de fondo incluso en caso de error
            if (stopBackgroundAudio && typeof stopBackgroundAudio === 'function') {
                try {
                    await stopBackgroundAudio();
                } catch (err) {
                    // Ignorar error al detener
                }
            }

            return false;
        }
    };

    /**
     * 🔌 LAZY STT INITIALIZER
     * Only spins up UDP, Bridge, and OpenAI connection when actually needed.
     */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /**
     * ✅ FIX: Esperar materialización real del canal en ARI antes de agregarlo al bridge
     * Resuelve race condition donde el contrato dice READY pero ARI aún no resuelve el canal
     * 
     * @param {object} ari - ARI client
     * @param {string} channelId - ID del canal a verificar
     * @param {object} opts - Opciones: timeout (ms), interval (ms)
     * @returns {Promise<object|null>} - Estado del canal cuando está disponible, o null si timeout
     */
    const waitUntilChannelAvailable = async (ari, channelId, opts = {}) => {
        const {
            timeout = 800,
            interval = 50
        } = opts;

        const startTime = Date.now();
        let attempt = 0;

        while (Date.now() - startTime < timeout) {
            attempt++;
            try {
                const channelObj = ari.Channel();
                const channelState = await channelObj.get({ channelId });

                if (channelState && channelState.state && channelState.state !== 'Down') {
                    if (attempt > 1) {
                        log("info", `✅ [STT INIT] Canal ${channelId} materializado en ARI tras ${attempt} intentos (${Date.now() - startTime}ms)`, {
                            channelId,
                            state: channelState.state,
                            attempts: attempt,
                            elapsedMs: Date.now() - startTime
                        });
                    }
                    return channelState;
                }
            } catch (err) {
                // Canal aún no disponible - continuar esperando
                if (err.message && (err.message.includes('Channel not found') || err.message.includes('404'))) {
                    // Esperar antes del siguiente intento
                    await sleep(interval);
                    continue;
                }
                // Otro error - re-lanzar
                throw err;
            }

            await sleep(interval);
        }

        // Timeout alcanzado
        log("warn", `⏱️ [STT INIT] Timeout esperando materialización de canal ${channelId} en ARI (${timeout}ms)`, {
            channelId,
            attempts: attempt,
            elapsedMs: Date.now() - startTime
        });
        return null;
    };

    /**
     * 🎯 AUDIO-SAFE GATE: Verificar que el canal Snoop está listo para audio
     * ✅ REDEFINIDO: Usa eventos (StasisStart) + contrato como fuente de verdad
     * ❌ NO BLOQUEA por channels.get() que puede fallar aunque el canal existe
     * 
     * Condiciones OBLIGATORIAS (fuente de verdad):
     * 1. SnoopContract.state === READY (StasisStart ya recibido)
     * 2. SnoopContract.snoopId === snoopId (correlación correcta)
     * 3. SnoopContract.parentChannelId válido
     * 
     * Verificación OPCIONAL (best-effort telemetría):
     * - channels.get() como confirmación adicional (no bloqueante)
     * 
     * @param {object} ari - ARI client
     * @param {string} snoopId - ID del canal Snoop
     * @param {string} linkedId - LinkedId para logging
     * @param {object} opts - Opciones: timeout (ms), interval (ms)
     * @returns {Promise<boolean>} - true si audio está listo (por eventos), false si contrato no está READY
     */
    const ensureAudioReady = async (ari, snoopId, linkedId, opts = {}) => {
        const {
            timeout = 2000, // Reducido: solo esperar contrato, no ARI REST
            interval = 50
        } = opts;

        const startTime = Date.now();
        let attempt = 0;

        log("info", `🔍 [AUDIO_READY] Verificando Snoop ${snoopId} listo para audio (eventos + contrato como fuente de verdad)...`, {
            snoopId,
            linkedId,
            timeoutMs: timeout
        });

        // ✅ PRIORIDAD 1: Verificar contrato (fuente de verdad)
        while (Date.now() - startTime < timeout) {
            attempt++;
            try {
                const contract = await getSnoopContract(linkedId);

                // Verificar que el contrato confirma READY y correlación correcta
                if (contract &&
                    contract.state === SnoopState.READY &&
                    contract.snoopId === snoopId &&
                    contract.parentChannelId) {

                    // ✅ CONTRATO READY = StasisStart recibido = Audio listo
                    const elapsedMs = Date.now() - startTime;
                    log("info", `✅ [AUDIO_READY] Snoop ${snoopId} confirmado READY por contrato (StasisStart recibido) (${attempt} intentos, ${elapsedMs}ms)`, {
                        snoopId,
                        linkedId,
                        contractState: contract.state,
                        attempts: attempt,
                        latencyMs: elapsedMs,
                        sourceOfTruth: 'SnoopContract_READY'
                    });

                    // 🎯 BEST-EFFORT: Intentar channels.get() como telemetría (no bloqueante)
                    // ✅ FIX: Esta llamada es puramente informativa. Si falla (404), NO afecta el resultado
                    // porque el Contrato ya confirmó que el canal existe (vía eventos StasisStart).
                    try {
                        const channelObj = ari.Channel();
                        const channelState = await channelObj.get({ channelId: snoopId });

                        if (!channelState || channelState.state === 'Down') {
                            log("warn", `⚠️ [AUDIO_READY] Snoop ${snoopId} contrato READY pero canal físico DOWN/Invalid (Intento ${attempt}) - Telemetría inconsistente, pero confiando en Contrato`);
                            // NO reintentar - El contrato dice READY (StasisStart recibió), el audio fluye.
                        } else {
                            log("debug", `📊 [AUDIO_READY] Verificación física OK: Snoop ${snoopId} (state: ${channelState.state})`);
                        }
                    } catch (ariErr) {
                        // 🎯 ADAPTACIÓN ARQUITECTÓNICA: Snoop RX puede no ser resoluble como canal clásico
                        // Si falla channels.get() pero el contrato está READY, asumimos que el audio fluye via Bridge.
                        log("warn", `⚠️ [AUDIO_READY] Error verificando canal físico Snoop ${snoopId}: ${ariErr.message} - Ignorando (SourceOfTruth = Contract)`);
                    }

                    // ✅ PRINCIPAL: Si el contrato dice READY, es VERDAD.
                    return true; // ✅ Audio listo por eventos + contrato
                } else {
                    // Contrato no está READY aún - esperar un poco más
                    if (contract) {
                        log("debug", `⏳ [AUDIO_READY] Snoop ${snoopId} contrato en estado ${contract.state}, esperando READY...`, {
                            snoopId,
                            linkedId,
                            contractState: contract.state,
                            attempt
                        });
                    }
                    await sleep(interval);
                    continue;
                }
            } catch (err) {
                // Error obteniendo contrato - esperar y reintentar
                log("warn", `⚠️ [AUDIO_READY] Error obteniendo contrato: ${err.message}, reintentando...`, {
                    snoopId,
                    linkedId,
                    attempt
                });
                await sleep(interval);
                continue;
            }
        }

        // Timeout - contrato no está READY
        const elapsedMs = Date.now() - startTime;
        log("warn", `⏱️ [AUDIO_READY] Timeout esperando contrato READY para Snoop ${snoopId} (${timeout}ms, ${attempt} intentos)`, {
            snoopId,
            linkedId,
            attempts: attempt,
            elapsedMs
        });

        return false;
    };

    const addChannelToBridgeWithRetry = async (bridge, channelId, opts = {}) => {
        const {
            label = "unknown",
            maxAttempts = 10,
            baseDelayMs = 100,
            maxDelayMs = 500
        } = opts;

        // 🛡️ VALIDACIÓN CRÍTICA: Verificar que el canal existe antes de intentar agregarlo
        try {
            const channelObj = ari.Channel();
            const channelState = await channelObj.get({ channelId });
            if (!channelState || channelState.state === 'Down') {
                log("warn", `⚠️ [STT INIT] Canal ${channelId} no disponible (estado: ${channelState?.state || 'null'}), omitiendo agregar al bridge`);
                throw new Error(`Channel ${channelId} is not available (state: ${channelState?.state || 'null'})`);
            }
        } catch (channelErr) {
            if (channelErr.message && (channelErr.message.includes('Channel not found') || channelErr.message.includes('404'))) {
                log("warn", `⚠️ [STT INIT] Canal ${channelId} ya no existe (hangup temprano), omitiendo agregar al bridge`);
                throw channelErr; // No reintentar si el canal no existe
            }
            // Si es otro error de validación, también fallar rápido
            if (channelErr.message && channelErr.message.includes('not available')) {
                throw channelErr;
            }
            // Si no es un error de validación, continuar con el retry normal (puede ser un error temporal)
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await bridge.addChannel({ channel: channelId });
                if (attempt > 1) {
                    log("info", `✅ [STT INIT] addChannel OK tras retry`, { label, channelId, attempt });
                }
                return;
            } catch (err) {
                const msg = err?.message || String(err);
                const isStasisRace = /Channel not in Stasis application/i.test(msg);
                const isRecordingConflict = /currently recording/i.test(msg);
                const isChannelNotFound = /Channel not found/i.test(msg) || /404/i.test(msg);

                // 🛡️ Si el canal no existe, no reintentar infinitamente
                if (isChannelNotFound) {
                    log("warn", `⚠️ [STT INIT] Canal ${channelId} ya no existe, omitiendo agregar al bridge`);
                    throw new Error(`Channel ${channelId} not found - hangup detected`);
                }

                // Retry para ambos casos: Stasis race Y conflicto de grabación
                if ((!isStasisRace && !isRecordingConflict) || attempt === maxAttempts) {
                    log("error", `❌ [STT INIT] addChannel falló`, { label, channelId, attempt, message: msg });
                    throw err;
                }

                const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
                const reason = isRecordingConflict ? "recording conflict" : "race Stasis";
                log("warn", `⏳ [STT INIT] addChannel retry (${reason})`, { label, channelId, attempt, delayMs: delay, message: msg });
                await sleep(delay);
            }
        }
    };

    const ensureSTT = async (options = {}) => {
        // ✅ ARQUITECTURA DESACOPLADA: STT puede inicializarse temprano (early init)
        // options.earlyInit permite inicializar STT antes de entrar a fase LISTEN_*
        const { earlyInit = false } = options;

        // 🎯 FIX 1: Usar fase REAL del engine (desde Redis), NO domainContext.state
        // domainContext.state puede estar desincronizado o ser obsoleto durante la creación del Snoop
        const linkedId = channel.linkedid || channel.id;
        const currentPhase = await redis.get(`phase:${linkedId}`) || domainContext.state?.rutPhase || 'UNKNOWN';
        const listenPhases = ['LISTEN_RUT', 'LISTEN_OPTION', 'LISTEN_CONFIRMATION'];
        const isListenPhase = listenPhases.includes(currentPhase);

        // 🛡️ GUARD CLAUSE: Solo permitir STT en fases LISTEN_* O si es earlyInit
        if (!isListenPhase && !earlyInit) {
            log("debug", `🔒 [STT] ensureSTT ignorado fuera de fase LISTEN_* (earlyInit=${earlyInit})`, {
                phase: currentPhase,
                allowedPhases: listenPhases,
                linkedId: linkedId
            });
            return;
        }

        if (earlyInit) {
            log("info", `🔒 [STT] Early initialization enabled - STT se inicializará antes de fase LISTEN_*`);
        }

        // 📊 LOG DETALLADO: Estado inicial de ensureSTT
        log("info", `🔒 [LIFECYCLE] ensureSTT iniciado:`, {
            phase: currentPhase,
            phaseSource: 'Redis',
            linkedId: linkedId,
            channelId: channel.id,
            sttInitialized: sttInitialized,
            sttPhaseInitialized: sttPhaseInitialized || 'NULL',
            isListenPhase: isListenPhase,
            sttInitAttempted: sttInitAttempted,
            sttLastInitAttemptAt: sttLastInitAttemptAt,
            domainContextAudioChannelId: domainContext.audioChannelId || 'none'
        });

        // ✅ ARQUITECTURA DESACOPLADA: STT inicializado temprano se mantiene activo
        // NO reinicializar STT si ya está inicializado (independiente de la fase)
        // El STT debe inicializarse UNA sola vez por llamada, no por fase
        // 🎯 EXCEPCIÓN: Si el STT fue cerrado (hard stop), permitir nueva sesión limpia
        const sttClosed = await redis.get(`voicebot:quintero:${linkedId}:stt:closed`);
        if (sttInitialized && !sttClosed) {
            // ✅ STT ya está activo - no reinicializar
            log("debug", `🔒 [STT] STT ya inicializado (fase inicial: ${sttPhaseInitialized || 'EARLY'}), NO reinicializando - Canal de entrada activo`, {
                phase: currentPhase,
                sttPhaseInitialized: sttPhaseInitialized || 'EARLY',
                channelId: channel.id,
                linkedId: linkedId,
                earlyInit: earlyInit
            });
            return; // ✅ STT ya está vivo, mantener activo durante toda la llamada
        } else if (sttClosed && (isListenPhase || earlyInit)) {
            // 🎯 STT fue cerrado (hard stop) - permitir nueva sesión limpia
            log("info", `🔄 [STT] STT fue cerrado previamente (hard stop), permitiendo nueva sesión limpia para ${currentPhase}`, {
                phase: currentPhase,
                channelId: channel.id,
                linkedId: linkedId
            });
            sttInitialized = false;
            sttPhaseInitialized = null;
            sttInitAttempted = false; // 🎯 CRÍTICO: Resetear flag para permitir nuevo intento
            sttLastInitAttemptAt = 0; // Resetear también el guard temporal
        }

        // 🎯 GUARD TEMPORAL ANTI-LOOP: Evitar reintentos cada TURN si el Snoop aún no vuelve
        const now = Date.now();
        const timeSinceLastAttempt = now - sttLastInitAttemptAt;
        if (sttLastInitAttemptAt > 0 && timeSinceLastAttempt < 1000) {
            log("debug", `⏸️ [STT] Guard temporal activo: último intento hace ${timeSinceLastAttempt}ms, esperando ${1000 - timeSinceLastAttempt}ms antes de reintentar`, {
                timeSinceLastAttempt: timeSinceLastAttempt,
                sttLastInitAttemptAt: sttLastInitAttemptAt,
                now: now,
                phase: currentPhase,
                channelId: channel.id
            });
            await new Promise(resolve => setTimeout(resolve, 1000 - timeSinceLastAttempt));
            // 🎯 CONTINUE: Proceed to initialization after wait
        }
        sttLastInitAttemptAt = now; // 🎯 Marcar tiempo del intento actual

        log("info", `🔌 [ENGINE] Initializing STT Stack (Lazy Load) para fase ${currentPhase || 'UNKNOWN'}...`, {
            phase: currentPhase,
            channelId: channel.id,
            linkedId: linkedId,
            sttLastInitAttemptAt: now
        });

        // 🎯 SINGLETON LOCK: Prevenir tormenta de STT (Anti-DDoS self-inflicted)
        if (sttInitializing) {
            log("warn", `🔒 [STT] ensureSTT ignorado: inicialización en curso (Singleton Lock active)`);
            return;
        }
        sttInitializing = true;

        try {
            // 1. UDP STREAM SETUP
            const udpRes = await setupUdpStream(openaiClient, sttMode, legacyAudioBuffer);
            udpServer = udpRes.server;
            udpPort = udpRes.port;

            // 🎯 PASO 1: Determinar audioSource ANTES de crear el bridge
            // Esto evita el error "Cannot access 'audioSource' before initialization"
            const linkedId = channel.linkedid || channel.id;
            let audioSource = domainContext.audioChannelId;

            // 🎯 FIX 2: En LISTEN_RUT, el Snoop es OBLIGATORIO (no fallback a canal principal)
            // 🛡️ VALIDACIÓN: Intentar recuperar Snoop desde contrato o Redis legacy
            if (!audioSource || audioSource === channel.id) {
                // 🎯 PRIORIDAD 1: Contrato formal de Snoop
                const contract = await getSnoopContract(linkedId);
                if (contract && contract.snoopId && contract.snoopId !== channel.id) {
                    log("info", `🔁 [STT INIT] Recuperando Snoop desde contrato: ${contract.snoopId} (estado: ${contract.state})`);
                    audioSource = contract.snoopId;
                } else {
                    // 🎯 PRIORIDAD 2: Redis legacy (compatibilidad)
                    const redisSnoopId = await redis.get(`snoop:active:${linkedId}`) || await redis.get(`snoop:created:${channel.id}`);
                    if (redisSnoopId && redisSnoopId !== channel.id) {
                        log("info", `🔁 [STT INIT] Recuperando Snoop desde Redis legacy: ${redisSnoopId}`);
                        audioSource = redisSnoopId;
                    } else {
                        // 🎯 REGLA DE GOBERNANZA: En LISTEN_RUT, Snoop es REQUERIDO
                        if (currentPhase === 'LISTEN_RUT' || currentPhase === 'LISTEN_OPTION' || currentPhase === 'LISTEN_CONFIRMATION') {
                            log("error", `❌ [STT INIT] Snoop REQUERIDO en fase ${currentPhase} pero no está disponible - Abortando STT`);
                            throw new Error(`Snoop not ready for STT in phase ${currentPhase}`);
                        } else {
                            // ⚠️ FALLBACK solo permitido fuera de LISTEN_*
                            log("warn", `⚠️ [STT INIT] No hay Snoop RX disponible, usando canal principal como fallback (phase=${currentPhase})`);
                            audioSource = channel.id;
                        }
                    }
                }
            }

            // 🎯 FIX 3: Validación basada en CONTRATO FORMAL, NO en channels.get()
            // El contrato de Snoop es la fuente de verdad, ARI es best-effort
            if (audioSource && audioSource !== channel.id) {
                // 🎯 VALIDACIÓN PRIMARIA: Contrato formal de Snoop
                const contract = await getSnoopContract(linkedId);

                if (!contract) {
                    if (currentPhase === 'LISTEN_RUT' || currentPhase === 'LISTEN_OPTION' || currentPhase === 'LISTEN_CONFIRMATION') {
                        log("error", `❌ [STT INIT] No existe contrato de Snoop para linkedId=${linkedId} - Abortando STT`);
                        throw new Error(`Snoop contract missing for linkedId=${linkedId}`);
                    } else {
                        log("warn", `⚠️ [STT INIT] No hay contrato de Snoop, usando canal principal como fallback`);
                        audioSource = channel.id;
                    }
                } else if (contract.snoopId !== audioSource) {
                    log("error", `❌ [STT INIT] Contrato de Snoop no coincide: esperado=${audioSource}, contrato=${contract.snoopId} - Abortando STT`);
                    throw new Error(`Snoop contract mismatch: expected=${audioSource}, contract=${contract.snoopId}`);
                } else {
                    // 🎯 ENGINE_MODE: Comportamiento diferente según modo
                    const ENGINE_MODE = config.engine.ENGINE_MODE || 'production';
                    const STRICT_INVARIANTS = config.engine.STRICT_INVARIANTS || false;
                    const FAIL_FAST_ON_CONTRACT = config.engine.FAIL_FAST_ON_CONTRACT || false;

                    // 🎯 PRODUCTION_TIMING: Verificar si el Snoop realmente existe antes de continuar
                    // Si está en WAITING_AST pero el canal no existe, recrearlo
                    let snoopExists = false;
                    if (contract.state === SnoopState.WAITING_AST || contract.state === SnoopState.READY) {
                        try {
                            const snoopChannel = ari.Channel();
                            const channelState = await snoopChannel.get({ channelId: audioSource });
                            snoopExists = channelState && channelState.state && channelState.state !== 'Down';
                        } catch (e) {
                            snoopExists = false;
                        }
                    }

                    // ✅ REGLA 2: debug_strict solo alerta, NO bloquea si StasisStart ya llegó
                    // Si el contrato está en WAITING_AST pero StasisStart ya llegó (correlacionado),
                    // permitir STT - el evento es la fuente de verdad, no channels.get()
                    if (ENGINE_MODE === 'debug_strict' && contract.state !== SnoopState.READY) {
                        // Verificar si StasisStart ya llegó (canal existe en Stasis aunque channels.get() falle)
                        const snoopActiveInRedis = await redis.get(`snoop:active:${linkedId}`);
                        if (snoopActiveInRedis === audioSource) {
                            // StasisStart ya llegó y correlacionó - permitir STT
                            log("warn", `⚠️ [STT INIT] DEBUG_STRICT: Snoop ${audioSource} en ${contract.state} pero StasisStart ya correlacionó - Permitiendo STT`, { linkedId, currentPhase });
                        } else {
                            // StasisStart aún no llegó - bloquear STT
                            log("error", `❌ [STT INIT] DEBUG_STRICT: Snoop ${audioSource} no está READY (state=${contract.state}) y StasisStart no correlacionó - Bloqueando STT`, { linkedId, currentPhase });
                            throw new Error(`STT_BLOCKED_SNOOP_NOT_READY: Snoop ${audioSource} en estado ${contract.state}, requiere READY en modo debug_strict`);
                        }
                    }

                    if (contract.state === SnoopState.WAITING_AST) {
                        // ✅ FIX: Snoop persistente - NO recrear, solo esperar StasisStart
                        // El Snoop es un recurso de SESIÓN, no de fase
                        // Si está en WAITING_AST, significa que está esperando confirmación de Asterisk
                        // NO destruir ni recrear - solo esperar
                        log("info", `🔄 [STT INIT] Snoop ${audioSource} en WAITING_AST - Esperando StasisStart (Snoop persistente, NO recrear)`, {
                            linkedId,
                            currentPhase,
                            snoopExists
                        });

                        // Usar el Snoop existente aunque esté en WAITING_AST
                        // El StasisStart llegará y lo transicionará a READY
                        domainContext.audioChannelId = audioSource;
                        // NO lanzar error - permitir que el flujo continúe esperando
                        // El dominio puede decidir fallback si es necesario
                        throw new Error(`STT_BLOCKED_SNOOP_WAITING_AST: Snoop ${audioSource} en WAITING_AST, esperando StasisStart. Snoop persistente, no recrear.`);
                    } else if (contract.state === SnoopState.DESTROYED || contract.state === SnoopState.RELEASABLE) {
                        // ✅ FIX: Solo recrear si el Snoop fue explícitamente destruido (DESTROYED/RELEASABLE)
                        // Estados transitorios (CREATED, WAITING_AST) NO deben recrear - el Snoop es persistente
                        log("warn", `⚠️ [STT INIT] Snoop ${audioSource} en estado terminal (state=${contract.state}) - Recreando snoop para ${currentPhase}...`);

                        // Limpiar referencia del contrato destruido
                        domainContext.audioChannelId = channel.id;
                        audioSource = channel.id; // Temporal, se creará nuevo abajo

                        // Crear nuevo snoop (solo si fue destruido)
                        try {
                            const SNOOP_APP = "media-snoop";
                            const appArgs = `linkedId=${linkedId}`;

                            // ✅ LOG 1: Creación del Snoop (fuente de verdad) - RECREATION (destroyed state)
                            log("info", "🕵️‍♂️ [SNOOP CREATE] Recreando Snoop (estado terminal)", {
                                snoopId: "pending",
                                parentChannelId: channel.id,
                                linkedId,
                                app: SNOOP_APP,
                                appArgs,
                                spy: 'in',
                                whisper: 'none',
                                reason: "snoop_destroyed",
                                previousState: contract.state,
                                phase: currentPhase
                            });

                            const newSnoop = await ari.channels.snoopChannel({
                                channelId: channel.id,
                                app: SNOOP_APP,
                                appArgs: appArgs,
                                spy: 'in',
                                whisper: 'none'
                            });

                            // ✅ PRIORIDAD 4: Log decisivo de creación
                            log("info", "📊 [SNOOP_CREATE_RESULT]", {
                                snoopId: newSnoop.id,
                                parentChannelId: channel.id,
                                linkedId,
                                appArgs,
                                app: SNOOP_APP,
                                ts: Date.now()
                            });

                            // ✅ LOG 1: Confirmación de creación con ID real
                            log("info", "🕵️‍♂️ [SNOOP CREATE] Snoop recreado exitosamente", {
                                snoopId: newSnoop.id,
                                parentChannelId: channel.id,
                                linkedId,
                                app: SNOOP_APP,
                                appArgs,
                                timestamp: Date.now()
                            });

                            await createSnoopContract(linkedId, newSnoop.id, channel.id);
                            await transitionSnoopState(linkedId, SnoopState.CREATED, SnoopState.WAITING_AST);

                            domainContext.audioChannelId = newSnoop.id;
                            audioSource = newSnoop.id;
                            log("info", `✅ [STT INIT] Nuevo Snoop ${newSnoop.id} creado (esperando StasisStart) para ${currentPhase}`);
                        } catch (recreateErr) {
                            log("error", `❌ [STT INIT] Error recreando Snoop: ${recreateErr.message}`);
                            throw new Error(`STT_BLOCKED_SNOOP_STATE_CREATED`);
                        }
                    } else if (contract.state === SnoopState.READY) {
                        // ✅ REGLA 1: Si el contrato está READY, StasisStart ya llegó
                        // 🎯 HARDENING: Verificar FÍSICAMENTE usando AudioPlaneController (Source of Truth = Physical)

                        const physicalOk = await AudioPlaneController.checkPhysical(ari, audioSource);

                        if (!physicalOk) {
                            log("error", `❌ [STT INIT] FATAL: Snoop ${audioSource} contrato READY pero AudioPlaneController reporta DOWN - ABORTANDO STT (Strict Gate)`);
                            throw new Error(`STT_BLOCKED_GHOST_CHANNEL: Snoop ${audioSource} contract READY but physical plane missing (Strict Gate)`);
                        }

                        // ✅ Snoop está READY y FÍSICAMENTE disponible
                        log("info", `✅ [STT INIT] Snoop ${audioSource} validado (Contrato READY + Physical Plane OK)`);
                        log("info", `✅ [STT CONTRACT] audioSource=${audioSource} | phase=${currentPhase} | Snoop PHYSICAL CHECKED`);
                        // ✅ Snoop está READY y FÍSICAMENTE disponible - CONTINUAR
                        domainContext.audioChannelId = audioSource;
                    }

                    // 🎯 VALIDACIÓN SECUNDARIA (BLANDA): channels.get() solo como verificación opcional
                    try {
                        const snoopChannelObj = ari.Channel();
                        const snoopState = await snoopChannelObj.get({ channelId: audioSource });
                        if (snoopState && snoopState.state !== 'Down') {
                            log("debug", `✅ [STT INIT] Canal Snoop ${audioSource} también verificado vía ARI (estado: ${snoopState.state})`);
                        }
                    } catch (snoopErr) {
                        // ⚠️ NO abortar - el contrato ya validó que está READY
                        log("debug", `⚠️ [STT INIT] channels.get() falló para Snoop ${audioSource} (${snoopErr.message}), pero contrato confirma READY - Continuando STT`);
                    }
                }
            }

            log("info", `🎯 [STT INIT] audioSource determinado: ${audioSource} (${audioSource === channel.id ? 'canal principal' : 'Snoop RX'})`);

            // 2. BRIDGE & EXTERNAL MEDIA
            // 🎯 CRÍTICO: Si el Snoop ya está anclado (estado READY), el bridge ya existe
            // Si no existe, crearlo (fallback para casos legacy)
            if (!captureBridge) {
                captureBridge = ari.Bridge();
                await captureBridge.create({ type: 'mixing,dtmf_events' });
                log("info", `🌉 [BRIDGE] Bridge de captura creado ${captureBridge.id} (fallback)`);
            } else {
                log("info", `🌉 [BRIDGE] Usando bridge de captura existente ${captureBridge.id} (Snoop ya anclado)`);
            }

            // 🔧 FIX: Obtener contrato ANTES de cualquier uso (fuera del bloque condicional)
            const contract = await getSnoopContract(linkedId);

            // 🎯 Si el Snoop está en estado READY, ya está anclado al bridge
            // Solo verificar que está en el bridge, no intentar agregarlo de nuevo
            if (audioSource && audioSource !== channel.id) {
                // ✅ FIX: Verificar contrato PRIMERO (fuente de verdad)
                const contractIsReady = contract && (contract.state === SnoopState.READY || contract.state === SnoopState.CONSUMED);

                // 🎯 CRÍTICO: channels.get() es best-effort si el contrato está READY
                // No abortar STT si channels.get() falla pero el contrato confirma READY
                let channelState = null;
                let channelsGetFailed = false;

                if (contractIsReady) {
                    // Si el contrato está READY, hacer channels.get() como validación opcional (no fatal)
                    try {
                        const snoopChannel = ari.Channel();
                        channelState = await snoopChannel.get({ channelId: audioSource });
                        if (channelState && channelState.state !== 'Down') {
                            log("debug", `✅ [STT INIT] Canal Snoop ${audioSource} verificado vía ARI (estado: ${channelState.state})`);
                        }
                    } catch (snoopCheckErr) {
                        channelsGetFailed = true;
                        // ⚠️ NO abortar - el contrato ya confirma READY
                        log("warn", `⚠️ [STT INIT] channels.get() falló para Snoop ${audioSource} (${snoopCheckErr.message}), pero contrato confirma ${contract.state} - Continuando STT`);
                    }
                } else {
                    // Si el contrato NO está READY, hacer channels.get() como validación requerida
                    try {
                        const snoopChannel = ari.Channel();
                        channelState = await snoopChannel.get({ channelId: audioSource });
                        if (!channelState || channelState.state === 'Down') {
                            log("error", `❌ [STT INIT] Snoop ${audioSource} no existe o está Down - Abortando STT`);
                            throw new Error(`STT_INIT_FAILED: Snoop ${audioSource} no existe o está Down`);
                        }
                    } catch (snoopCheckErr) {
                        log("error", `❌ [STT INIT] Snoop ${audioSource} no disponible: ${snoopCheckErr.message} - Abortando STT`);
                        throw new Error(`STT_INIT_FAILED: Snoop ${audioSource} no disponible: ${snoopCheckErr.message}`);
                    }
                }
            }

            // ✅ PRIORIDAD 1: AUDIO-SAFE GATE - Verificar que el Snoop está materializado ANTES de crear ExternalMedia
            // El contrato puede decir READY, pero el canal debe estar físicamente disponible en ARI
            // 🔧 FIX: Solo ejecutar Audio-Safe Gate si hay un Snoop válido (no canal principal)
            if (audioSource && audioSource !== channel.id) {
                log("info", `🔍 [STT INIT] Verificando Audio-Safe Gate para Snoop ${audioSource}...`, {
                    snoopId: audioSource,
                    linkedId,
                    contractState: contract?.state
                });

                const audioReady = await ensureAudioReady(ari, audioSource, linkedId, {
                    timeout: 2000, // Reducido: solo esperar contrato READY, no ARI REST
                    interval: 50
                });

                if (!audioReady) {
                    log("error", `❌ [STT INIT] Audio-Safe Gate falló: Snoop ${audioSource} contrato no está READY después de timeout - INVALIDANDO CONTRATO para forzar recreación`, {
                        snoopId: audioSource,
                        linkedId,
                        contractState: contract?.state
                    });

                    // 🎯 SELF-HEALING: Destruir el contrato fantasma para que el próximo reintento cree uno nuevo
                    try {
                        await destroySnoop(linkedId);
                        log("warn", `🧹 [STT INIT] Contrato Snoop ${audioSource} destruido preventivamente (Self-Healing)`);
                    } catch (cleanupErr) {
                        log("error", `⚠️ [STT INIT] Error destruyendo contrato Snoop: ${cleanupErr.message}`);
                    }

                    throw new Error(`STT_BLOCKED_AUDIO_NOT_READY: Snoop ${audioSource} contrato no está READY - Audio-Safe Gate falló`);
                }

                log("info", `✅ [STT INIT] Audio-Safe Gate pasado: Snoop ${audioSource} materializado y listo para audio`, {
                    snoopId: audioSource,
                    linkedId
                });
            } else {
                // Si no hay Snoop (usando canal principal), no ejecutar Audio-Safe Gate
                log("info", `⏭️ [STT INIT] Saltando Audio-Safe Gate (usando canal principal ${channel.id}, no Snoop)`);
            }

            // Add source to bridge (ahora que sabemos que está materializado si pasó Audio-Safe Gate)
            // 🎯 CRÍTICO: Si el Snoop ya está anclado según el contrato, NO intentar agregarlo de nuevo
            // 🔧 FIX: contract ya está definido arriba, no re-obtenerlo
            // Solo intentar agregar Snoop si existe y es diferente del canal principal
            if (audioSource && audioSource !== channel.id) {
                try {
                    if (contract && contract.state === SnoopState.READY && contract.captureBridgeId === captureBridge.id) {
                        log("info", `✅ [STT INIT] Snoop ${audioSource} ya está anclado al capture bridge ${captureBridge.id} (contrato READY) - Saltando addChannel`);
                    } else if (contract && contract.state === SnoopState.CONSUMED && contract.captureBridgeId === captureBridge.id) {
                        log("info", `✅ [STT INIT] Snoop ${audioSource} ya está anclado y consumido (contrato CONSUMED) - Saltando addChannel`);
                    } else if (contract && contract.state === SnoopState.READY) {
                        // 🎯 ARCHITECTURE FIX: Snoop RX no requiere ser agregado al bridge (ya escucha)
                        // Intentar agregarlo causa 404 porque el canal no es manipulable por ARI
                        log("info", `✅ [STT INIT] Snoop ${audioSource} RX detectado (Contract READY). OMITIENDO addChannelToBridge (Comportamiento esperado para Snoop).`);
                        // NO ejecutar addChannelToBridgeWithRetry(captureBridge, audioSource)
                    } else {
                        // Contrato NO está READY - esto no debería pasar si Audio-Safe Gate pasó
                        log("error", `❌ [STT INIT] Contrato Snoop ${audioSource} en estado ${contract?.state || 'UNKNOWN'} después de Audio-Safe Gate`, {
                            snoopId: audioSource,
                            contractState: contract?.state,
                            linkedId
                        });
                        throw new Error(`STT_BLOCKED_SNOOP_NOT_READY: Snoop ${audioSource} en estado ${contract?.state || 'UNKNOWN'}, requiere READY`);
                    }
                } catch (err) {
                    if (err.message && (err.message.includes('Channel not found') || err.message.includes('not available') || err.message.includes('hangup detected'))) {
                        log("warn", `⚠️ [STT INIT] No se pudo agregar canal ${audioSource} al bridge (hangup temprano), omitiendo inicialización STT`);
                        throw err; // Re-lanzar para que el catch externo lo maneje
                    }
                    throw err; // Re-lanzar otros errores
                }
            } else {
                // Si no hay Snoop (usando canal principal), no intentar agregarlo al capture bridge
                log("info", `⏭️ [STT INIT] Saltando agregar Snoop al bridge (usando canal principal ${channel.id})`);
            }

            const localIp = getLocalIp();

            const externalId = `stt-${linkedId}-${Date.now()}`;

            // ✅ PRIORIDAD 1: Create External Media SOLO después de Audio-Safe Gate
            // ✅ FIX A: Pasar appArgs para correlación y evitar que se procese como inbound vacío
            const externalMediaAppArgs = `linkedId=${linkedId},role=externalMedia,kind=stt`;
            log("info", `🌊 [STT INIT] Creando ExternalMedia después de Audio-Safe Gate...`, {
                externalId,
                linkedId,
                snoopId: audioSource
            });

            externalChannel = await ari.channels.externalMedia({
                app: ARI_APP,
                channelId: externalId,
                external_host: `${localIp}:${udpPort}`,
                format: 'ulaw',
                direction: 'both',
                appArgs: externalMediaAppArgs
            });
            log("info", `🌊 [ExternalMedia] Created ${externalId} -> ${localIp}:${udpPort} (app: ${ARI_APP}, appArgs: ${externalMediaAppArgs})`);

            // ✅ PRIORIDAD 1: Agregar ExternalMedia al bridge inmediatamente (Audio-Safe Gate ya pasó)
            log("info", `🔄 [STT INIT] Agregando ExternalMedia ${externalChannel.id} al capture bridge ${captureBridge.id} (Audio-Safe Gate pasado)...`);
            try {
                await addChannelToBridgeWithRetry(captureBridge, externalChannel.id, {
                    label: "externalMedia",
                    maxAttempts: 15,
                    baseDelayMs: 100,
                    maxDelayMs: 800
                });
                log("info", `✅ [STT INIT] ExternalMedia ${externalChannel.id} agregado exitosamente al capture bridge ${captureBridge.id}`);
            } catch (addErr) {
                const msg = addErr?.message || String(addErr);
                const isRecoverableError =
                    /Channel not in Stasis application/i.test(msg) ||
                    /Channel not found/i.test(msg) ||
                    /Stasis/i.test(msg) ||
                    /race/i.test(msg);

                if (isRecoverableError) {
                    log("warn", `⚠️ [STT INIT] Error recuperable al agregar ExternalMedia al bridge: ${msg} - permitiendo reintento`, {
                        externalChannelId: externalChannel.id,
                        captureBridgeId: captureBridge.id,
                        linkedId
                    });
                    throw new Error(`ExternalMedia bridge attachment failed (recoverable): ${msg}`);
                }

                log("error", `❌ [STT INIT] ExternalMedia no pudo ser agregado al bridge después de retry: ${msg}`, {
                    externalChannelId: externalChannel.id,
                    captureBridgeId: captureBridge.id,
                    linkedId
                });
                throw new Error(`ExternalMedia bridge attachment failed: ${msg}`);
            }

            // 🛡️ DETENER GRABACIÓN AUTOMÁTICA si el listener de ARI la inició (después de agregar al bridge)
            try {
                const recordingKey = `recording:${externalChannel.id}`;
                let recName = await redis.get(recordingKey);

                if (!recName) {
                    const linkedIdKey = `recording:${linkedId}`;
                    recName = await redis.get(linkedIdKey);
                }

                if (recName) {
                    log("info", `🛑 [STT INIT] Deteniendo grabación automática iniciada por listener: ${recName}`);
                    try {
                        await ari.recordings.stop({ recordingName: recName });
                        await redis.del(recordingKey);
                        await redis.del(`recording:${linkedId}`);
                        log("info", `✅ [STT INIT] Grabación automática detenida`);
                    } catch (stopErr) {
                        if (!stopErr.message?.includes("not found") && !stopErr.message?.includes("Not found")) {
                            log("warn", `⚠️ [STT INIT] No se pudo detener grabación automática: ${stopErr.message}`);
                        }
                    }
                }
            } catch (recCheckErr) {
                log("debug", `🔍 [STT INIT] Verificación de grabación automática: ${recCheckErr.message}`);
            }

            log("info", `🌉 [BRIDGE] Wired Audio: ${audioSource} -> Bridge -> ${externalChannel.id} -> UDP`);

            await redis.set(`stt:channel:${linkedId}`, audioSource, { EX: 3600 });

            // 3. CONNECT OPENAI
            await openaiClient.connect();

            // 🎯 MEJORA CRÍTICA: Registrar callback para detección de estabilidad del stream
            // Esto permite invocar webhook cuando el stream se pausa, sin esperar el fin completo
            if (openaiClient.onStreamStable) {
                openaiClient.onStreamStable(async (reason) => {
                    const callKey = linkedId;
                    const deltaStateKey = `voicebot:quintero:${callKey}:rut:deltaState`;

                    const triggerReason = reason === 'stream-stable' ? 'stream-stable' :
                        reason === 'stream-paused' ? 'stream-paused' :
                            reason === 'stream-complete' ? 'stream-complete' : 'unknown';

                    log("info", `⏸️ [ENGINE] Stream estabilizado (${reason}) → Marcando businessReady para webhook`);

                    // Marcar estado como listo para negocio
                    await redis.set(deltaStateKey, JSON.stringify({
                        deltaOnly: false,
                        businessReady: true,
                        emptyCounter: 0,
                        triggerReason: triggerReason,
                        lastUpdate: Date.now(),
                        streamStability: true
                    }), { EX: 30 });

                    // 🎯 TRIGGER INMEDIATO: Invocar webhook cuando stream se estabiliza
                    // Esto resuelve el problema de espera implícita por fin de stream
                    // 🎯 CRÍTICO: El webhook cerrará el STT automáticamente para evitar captura post-RUT
                    if (reason === 'stream-stable' || reason === 'stream-paused') {
                        log("info", `🚀 [ENGINE] Trigger inmediato de webhook tras estabilidad de stream (${reason})`);
                        invokeRutWebhook(callKey, triggerReason, { playBackgroundAudio: true }).catch(err => {
                            log("error", `❌ [ENGINE] Error en trigger inmediato de webhook: ${err.message}`);
                        });
                    }
                });
                log("info", "🎯 [ENGINE] Callback de estabilidad de stream registrado");
            }

            // 🎯 INCREMENTAL TRANSCRIPTION: Registrar callback para partials
            // El callback se ejecuta solo cuando el modo incremental está activo
            if (openaiClient.onPartialTranscript !== undefined) {
                // 🎙️ SEGMENTER: Registrar deltas como marcas (si está habilitado)
                const originalOnPartialTranscript = openaiClient.onPartialTranscript;

                // 🎯 MEJORA: Estado para tracking de eventos vacíos y debounce
                const deltaTracking = {
                    emptyCounter: 0,
                    lastDeltaAt: 0,
                    debounceTimer: null,
                    isStreaming: false
                };

                openaiClient.onPartialTranscript = async (partialText, sessionId, isDelta = false) => {
                    // 🎯 CRÍTICO: Definir callKey al inicio del callback (usado en todo el scope)
                    const callKey = sessionId || linkedId;

                    // 🎙️ SEGMENTER: Registrar delta como marca (si está habilitado)
                    if (USE_SEGMENTED_STT && segmenter && isDelta && partialText) {
                        segmenter.onDelta(partialText, { sessionId });
                    }

                    // 🎯 VAD MULTI-FUENTE: Marcar evidencia de voz cuando llegan deltas/completed
                    // Esto permite que waitForRealVoice detecte voz incluso si TALK_DETECT no funciona
                    const evidenceKey = `voicebot:quintero:${callKey}:rut:hasVoiceEvidence`;
                    if (partialText && partialText.trim().length > 0) {
                        await redis.set(evidenceKey, 'true', { EX: 30 });
                        log("debug", `🎤 [VAD] Evidencia de voz marcada por delta/completed: "${partialText.substring(0, 20)}..."`);
                    }

                    // 🕒 AUDITORÍA: Inicio del procesamiento
                    const tDeltaStart = Date.now();

                    // 🎯 REGLA CRÍTICA: Desactivar incremental si identidad está congelada (VALIDADO)
                    const frozenKey = `id:RUT:frozen:${sessionId}`;
                    const isIdentityFrozen = await redis.get(frozenKey);
                    if (isIdentityFrozen) {
                        log("debug", `🔒 [ENGINE] Identidad congelada (VALIDADO), desactivando incremental y ignorando input: "${partialText}"`);
                        if (openaiClient.disableIncremental) {
                            openaiClient.disableIncremental();
                        }
                        return; // Ignorar todo input posterior
                    }

                    const currentPhase = domainContext.state?.rutPhase;
                    const incrementalPhases = ['LISTEN_RUT', 'LISTEN_OPTION', 'LISTEN_CONFIRMATION'];

                    if (!incrementalPhases.includes(currentPhase)) {
                        log("debug", `📝 [ENGINE] Callback ignorado: phase=${currentPhase} no requiere incremental`);
                        return;
                    }

                    const now = Date.now();
                    const deltaStateKey = `voicebot:quintero:${callKey}:rut:deltaState`;

                    // 🎯 ARQUITECTURA CORRECTA: Separar completamente DELTAS vs COMPLETED
                    if (isDelta === false) {
                        // ✅ COMPLETED = FUENTE ÚNICA DE VERDAD
                        // El transcript completo es la única fuente confiable para construir RUT
                        // Los deltas NO son fuente de verdad (pueden perder inicio del utterance)

                        if (!partialText || partialText.trim().length === 0) {
                            log("debug", `📝 [ENGINE] Completed vacío recibido - ignorando`);
                            return;
                        }

                        log("info", `🎯 [ENGINE] COMPLETED recibido: "${partialText}" - Usando como fuente única de verdad`);

                        // 🧊 FIX: Congelar captura RUT al primer completed en LISTEN_RUT
                        // 🎯 Obtener fase desde Redis (más confiable que domainContext en callbacks)
                        const currentPhaseForCompleted = await redis.get(`phase:${callKey}`) || domainContext.state?.rutPhase || 'UNKNOWN';

                        // 🧊 Verificar si ya está congelado (desde Redis o memoria)
                        const isFrozenInRedis = await redis.get(`voicebot:quintero:${callKey}:rut:captureFrozen`);
                        const isFrozen = rutCaptureFrozen || isFrozenInRedis === 'true';

                        if (currentPhaseForCompleted === 'LISTEN_RUT' && !isFrozen) {
                            rutCaptureFrozen = true;
                            rutFirstCompletedAt = Date.now();

                            log("info", `🧊 [ENGINE] Captura RUT CONGELADA al primer completed (texto: "${partialText.substring(0, 30)}...")`, {
                                callKey,
                                phase: currentPhaseForCompleted,
                                timestamp: rutFirstCompletedAt
                            });

                            // 🧊 Detener commits periódicos
                            if (periodicCommitIntervalRef?.current) {
                                clearInterval(periodicCommitIntervalRef.current);
                                periodicCommitIntervalRef.current = null;
                                log("info", `🧊 [ENGINE] Commits periódicos detenidos (captura congelada)`);
                            }

                            // 🎯 HARD STOP: Cerrar sesión STT completamente para evitar corrupción de contexto
                            // Esto previene que OpenAI siga procesando audio y genere basura (chino, texto fuera de contexto)
                            try {
                                // PASO 1: Desactivar incremental (detiene emisión de deltas)
                                if (openaiClient && openaiClient.disableIncremental) {
                                    if (openaiClient.isIncrementalEnabled && openaiClient.isIncrementalEnabled()) {
                                        log("info", `🔒 [ENGINE] Desactivando incremental STT (hard stop)`);
                                        openaiClient.disableIncremental();
                                    }
                                }

                                // PASO 2: Desconectar WebSocket de OpenAI (cierra sesión completamente)
                                if (openaiClient && openaiClient.disconnect) {
                                    log("info", `🔒 [ENGINE] Desconectando sesión STT OpenAI (hard stop)`);
                                    openaiClient.disconnect();
                                }

                                // PASO 3: Cerrar ExternalMedia (detiene flujo de audio a STT)
                                if (externalChannel && externalChannel.hangup) {
                                    try {
                                        await externalChannel.hangup();
                                        log("info", `🔒 [ENGINE] ExternalMedia ${externalChannel.id} cerrado (hard stop)`);
                                    } catch (hangupErr) {
                                        log("warn", `⚠️ [ENGINE] Error al cerrar ExternalMedia: ${hangupErr.message}`);
                                    }
                                }

                                // PASO 4: Cerrar UDP server (detiene recepción de audio)
                                if (udpServer) {
                                    try {
                                        udpServer.close();
                                        log("info", `🔒 [ENGINE] UDP server cerrado (hard stop)`);
                                    } catch (udpErr) {
                                        log("warn", `⚠️ [ENGINE] Error al cerrar UDP server: ${udpErr.message}`);
                                    }
                                }

                                // PASO 5: Marcar STT como cerrado y resetear flags para permitir reinicialización
                                sttInitialized = false;
                                sttInitAttempted = false; // 🎯 CRÍTICO: Resetear para permitir nuevo intento en retry
                                sttLastInitAttemptAt = 0; // Resetear guard temporal
                                sttPhaseInitialized = null; // Limpiar fase inicializada
                                await redis.set(`voicebot:quintero:${callKey}:stt:closed`, 'true', { EX: 60 });

                                log("info", `✅ [ENGINE] HARD STOP completado: STT cerrado completamente para prevenir corrupción de contexto - Flags reseteados para permitir reinicialización`);
                            } catch (hardStopErr) {
                                log("error", `❌ [ENGINE] Error en hard stop de STT: ${hardStopErr.message}`);
                            }

                            // 🧊 Marcar captura como congelada en Redis
                            await redis.set(`voicebot:quintero:${callKey}:rut:captureFrozen`, 'true', { EX: 60 });
                        }

                        // 🧊 Si la captura está congelada, ignorar completed posteriores
                        if (isFrozen && currentPhaseForCompleted === 'LISTEN_RUT') {
                            log("info", `🧊 [ENGINE] Completed ignorado: captura RUT ya congelada (texto: "${partialText.substring(0, 30)}...")`, {
                                callKey,
                                frozenAt: rutFirstCompletedAt || 'unknown'
                            });
                            return;
                        }

                        // 🎯 AUDIO MARKS: Marcar chunk completado
                        await emitAudioMark(audioCtx, {
                            type: AudioMarkType.COMPLETED_CHUNK,
                            reason: "stt_completed",
                            meta: { text: partialText, callKey }
                        }, log, redis);

                        // 🎯 PASO 1: Guardar transcript completo como fuente única
                        await savePartialRut(callKey, partialText, false); // isDelta=false = fuente única

                        // 🎯 PASO 2: Actualizar lastSpeechTs
                        const lastSpeechTsKey = `voicebot:quintero:${callKey}:rut:lastSpeechTs`;
                        await redis.set(lastSpeechTsKey, String(now), { EX: 30 });

                        // 🎯 PASO 3: VALIDAR FILTRO SEMÁNTICO ANTES de disparar webhook
                        // 🎯 CRÍTICO: No disparar webhook si el texto no es candidato válido a RUT
                        // Esto previene webhooks con basura STT (chino, texto fuera de contexto, etc.)
                        // 🎯 FILOSOFÍA: PRIMERO entender (parseRutFromSpeech), DESPUÉS gobernar
                        const semanticFilter = (text) => {
                            const lowerText = text.toLowerCase();

                            // 🎯 PASO 1: Intentar parsear con parseRutFromSpeech (parser gobernado completo)
                            // Este parser SÍ puede convertir "catorce millones trescientos cuarenta y ocho mil doscientos cincuenta y ocho" → 14348258
                            try {
                                const parsed = parseRutFromSpeech(text);

                                // Si parseRutFromSpeech extrajo un body válido (7-9 dígitos), PERMITIR
                                // Incluso si falta DV, el webhook puede calcularlo o pedirlo
                                if (parsed && parsed.body && parsed.body >= 100000 && parsed.body <= 99999999) {
                                    if (parsed.ok && parsed.rut) {
                                        log("info", `🔍 [ENGINE] Filtro semántico: parseRutFromSpeech extrajo RUT completo: ${parsed.rut} - PERMITIENDO`);
                                        return { isValid: true, parsedRut: parsed.rut };
                                    } else {
                                        log("info", `🔍 [ENGINE] Filtro semántico: parseRutFromSpeech extrajo body válido: ${parsed.body} (reason: ${parsed.reason}) - PERMITIENDO (webhook calculará DV)`);
                                        return { isValid: true, parsedBody: parsed.body, parsedReason: parsed.reason };
                                    }
                                }

                                // Si parseRutFromSpeech devolvió un body pero fuera de rango, es un número pero no RUT
                                if (parsed && parsed.body && (parsed.body < 100000 || parsed.body > 99999999)) {
                                    log("info", `🔍 [ENGINE] Filtro semántico: parseRutFromSpeech extrajo número ${parsed.body} pero fuera de rango RUT (100000-99999999) - RECHAZANDO`);
                                    return { isValid: false, reason: 'BODY_OUT_OF_RANGE', parsedBody: parsed.body };
                                }
                            } catch (e) {
                                log("debug", `🔍 [ENGINE] Filtro semántico: parseRutFromSpeech falló: ${e.message}`);
                                // Continuar con validaciones estrictas solo si parseRutFromSpeech falló completamente
                            }

                            // 🎯 PASO 2: Gate duro SOLO si parseRutFromSpeech no pudo extraer nada
                            // Esto previene basura STT (chino, texto fuera de contexto) que no es numérico
                            try {
                                const normalizedDigits = textToDigits(text);
                                const digitsOnly = normalizedDigits.replace(/[^0-9Kk]/g, '');

                                if (!digitsOnly || digitsOnly.length === 0) {
                                    log("info", `🔍 [ENGINE] Filtro semántico: Texto no normalizable a dígitos ("${text.substring(0, 30)}...") - NO es candidato a RUT`);
                                    return { isValid: false, reason: 'NOT_NORMALIZABLE_TO_DIGITS' };
                                }

                                if (digitsOnly.length < 7 || digitsOnly.length > 9) {
                                    log("info", `🔍 [ENGINE] Filtro semántico: Texto normalizado tiene ${digitsOnly.length} dígitos (RUT requiere 7-9) - NO es candidato a RUT`);
                                    return { isValid: false, reason: 'INSUFFICIENT_DIGITS_AFTER_NORMALIZATION' };
                                }

                                // Verificar que el texto original contenga principalmente elementos numéricos
                                const directDigits = (text.match(/\d/g) || []).length;
                                const numericWords = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
                                    'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'veinte', 'treinta', 'cuarenta',
                                    'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa', 'cien', 'ciento',
                                    'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos',
                                    'setecientos', 'ochocientos', 'novecientos', 'millon', 'millones', 'mil', 'k', 'ka'];
                                const hasNumericWords = numericWords.some(word => lowerText.includes(word));

                                if (directDigits === 0 && !hasNumericWords) {
                                    log("info", `🔍 [ENGINE] Filtro semántico: Texto sin dígitos ni palabras numéricas ("${text.substring(0, 30)}...") - NO es candidato a RUT`);
                                    return { isValid: false, reason: 'NO_NUMERIC_CONTENT' };
                                }

                                // Si llegamos aquí, textToDigits pudo normalizar a 7-9 dígitos
                                // Aunque parseRutFromSpeech falló, el texto es numéricamente válido
                                log("info", `🔍 [ENGINE] Filtro semántico: Texto normalizado a ${digitsOnly.length} dígitos - PERMITIENDO (webhook validará)`);
                                return { isValid: true, normalizedDigits: digitsOnly };
                            } catch (e) {
                                log("debug", `🔍 [ENGINE] Filtro semántico: Error en normalización: ${e.message}`);
                                return { isValid: false, reason: 'NORMALIZATION_ERROR' };
                            }
                        };

                        const filterResult = semanticFilter(partialText);

                        if (!filterResult.isValid) {
                            log("info", `⏭️ [ENGINE] COMPLETED rechazado por filtro semántico: "${partialText.substring(0, 30)}..." (reason: ${filterResult.reason}) - NO disparando webhook`);
                            // NO marcar como businessReady ni disparar webhook
                            return;
                        }

                        // 🎯 PASO 4: Marcar como businessReady y disparar webhook INMEDIATAMENTE
                        await redis.set(deltaStateKey, JSON.stringify({
                            deltaOnly: false,
                            businessReady: true,
                            emptyCounter: 0,
                            triggerReason: 'transcription-completed',
                            lastUpdate: now
                        }), { EX: 30 });

                        // 🎯 PASO 5: Marcar evidencia de voz para VAD multi-fuente
                        await redis.set(`voicebot:quintero:${callKey}:rut:hasVoiceEvidence`, 'true', { EX: 30 });

                        // 🎯 PASO 6: Disparar webhook con transcript completo (solo si pasó filtro semántico)
                        // 🎯 CRÍTICO PARA LISTEN_RUT: Procesar inmediatamente sin gate de silencio
                        log("info", `🚀 [ENGINE] Trigger inmediato de webhook desde COMPLETED (transcription-completed) - Texto validado por filtro semántico`);
                        invokeRutWebhook(callKey, 'transcription-completed', {
                            playBackgroundAudio: true,
                            skipSilenceGate: true // 🎯 Para LISTEN_RUT, saltar gate de silencio
                        }).catch(err => {
                            log("error", `❌ [ENGINE] Error en trigger de webhook desde completed: ${err.message}`);
                        });

                        // 🎯 PASO 5: Cerrar debounce timer si existe (ya no es necesario)
                        if (deltaTracking.debounceTimer) {
                            clearTimeout(deltaTracking.debounceTimer);
                            deltaTracking.debounceTimer = null;
                        }
                        deltaTracking.isStreaming = false;

                        log("debug", `✅ [ENGINE] COMPLETED procesado: "${partialText}" - Webhook disparado`);
                        return;
                    }

                    // ✅ DELTAS = SOLO TIMING, NO TOKENS
                    // Los deltas solo sirven para:
                    // - Detectar que el usuario habló
                    // - Medir silencio / debounce
                    // - NO para construir identidad (esa es tarea del completed)

                    // 🧊 FIX: Ignorar deltas si la captura RUT está congelada
                    const currentPhaseForFreeze = await redis.get(`phase:${callKey}`) || domainContext.state?.rutPhase || 'UNKNOWN';
                    const isFrozenInRedisForDelta = await redis.get(`voicebot:quintero:${callKey}:rut:captureFrozen`);
                    const isFrozenForDelta = rutCaptureFrozen || isFrozenInRedisForDelta === 'true';

                    if (currentPhaseForFreeze === 'LISTEN_RUT' && isFrozenForDelta) {
                        log("debug", `🧊 [ENGINE] Delta ignorado: captura RUT congelada (texto: "${partialText?.substring(0, 20)}...")`);
                        return; // Ignorar deltas posteriores al freeze
                    }

                    const isEmpty = !partialText || partialText.trim().length === 0;

                    if (isEmpty) {
                        // Delta vacío - solo tracking para early trigger
                        deltaTracking.emptyCounter++;
                        await redis.set(deltaStateKey, JSON.stringify({
                            deltaOnly: true,
                            businessReady: false,
                            emptyCounter: deltaTracking.emptyCounter,
                            lastUpdate: now
                        }), { EX: 30 });

                        log("debug", `📝 [ENGINE] Delta vacío recibido (contador: ${deltaTracking.emptyCounter}/${EMPTY_EVENTS_THRESHOLD})`);

                        // Early trigger si 2 eventos vacíos consecutivos
                        if (deltaTracking.emptyCounter >= EMPTY_EVENTS_THRESHOLD) {
                            log("info", `🚨 [ENGINE] ${EMPTY_EVENTS_THRESHOLD} eventos vacíos consecutivos → Trigger early webhook`);
                            await redis.set(deltaStateKey, JSON.stringify({
                                deltaOnly: false,
                                businessReady: true,
                                emptyCounter: deltaTracking.emptyCounter,
                                triggerReason: 'early-stable-state',
                                lastUpdate: now
                            }), { EX: 30 });
                            deltaTracking.emptyCounter = 0;
                        }
                    } else {
                        // Delta con contenido - SOLO para timing, NO para tokens
                        deltaTracking.emptyCounter = 0;
                        deltaTracking.lastDeltaAt = now;
                        deltaTracking.isStreaming = true;

                        // 🎯 AUDIO MARKS: Marcar actividad por delta (evidencia de voz)
                        await emitAudioMark(audioCtx, {
                            type: AudioMarkType.DELTA_ACTIVITY,
                            reason: "stt_delta",
                            meta: { preview: partialText.substring(0, 20), callKey }
                        }, log, redis);

                        await redis.set(deltaStateKey, JSON.stringify({
                            deltaOnly: true,
                            businessReady: false,
                            emptyCounter: 0,
                            lastUpdate: now
                        }), { EX: 30 });

                        log("debug", `📝 [ENGINE] Delta recibido (solo timing): "${partialText}" - NO procesando tokens`);

                        // 🎯 CRÍTICO: NO guardar delta como token
                        // Los deltas NO son fuente de verdad, solo indican actividad
                        // NO llamar a savePartialRut() con isDelta=true

                        // Actualizar lastSpeechTs para timing
                        const lastSpeechTsKey = `voicebot:quintero:${callKey}:rut:lastSpeechTs`;
                        await redis.set(lastSpeechTsKey, String(now), { EX: 30 });

                        // Debounce temporal - resetear timer
                        if (deltaTracking.debounceTimer) {
                            clearTimeout(deltaTracking.debounceTimer);
                        }

                        // Timer de debounce para detectar estabilidad (fallback si no llega completed)
                        deltaTracking.debounceTimer = setTimeout(async () => {
                            const timeSinceLastDelta = Date.now() - deltaTracking.lastDeltaAt;
                            if (timeSinceLastDelta >= WEBHOOK_DEBOUNCE_MS && deltaTracking.isStreaming) {
                                log("info", `⏱️ [ENGINE] Debounce detectado (${timeSinceLastDelta}ms sin deltas) → Marcar como businessReady`);
                                await redis.set(deltaStateKey, JSON.stringify({
                                    deltaOnly: false,
                                    businessReady: true,
                                    emptyCounter: 0,
                                    triggerReason: 'audio-settled',
                                    lastUpdate: Date.now()
                                }), { EX: 30 });
                                deltaTracking.isStreaming = false;

                                // 🎯 FALLBACK: Si no llegó completed, usar texto consolidado actual
                                log("info", `🚀 [ENGINE] Trigger webhook tras debounce (audio-settled) - FALLBACK si no llegó completed`);
                                invokeRutWebhook(callKey, 'audio-settled', { playBackgroundAudio: true }).catch(err => {
                                    log("error", `❌ [ENGINE] Error en trigger de webhook desde debounce: ${err.message}`);
                                });
                            }
                        }, WEBHOOK_DEBOUNCE_MS);

                        log("debug", `✅ [ENGINE] Delta procesado (solo timing): lastSpeechTs actualizado`);
                    }
                };
                log("info", "🎯 [ENGINE] Callback de partials registrado correctamente con mejoras de webhook");
            } else {
                log("warn", "⚠️ [ENGINE] Cliente no soporta callback onPartialTranscript");
            }

            // 🎯 CRÍTICO: Validar que audioSource realmente existe antes de marcar como inicializado
            if (!audioSource || audioSource === channel.id) {
                // No hay Snoop válido - NO marcar como inicializado
                log("error", `❌ [STT INIT] STT no inicializado: audioSource inválido (${audioSource}) - Snoop requerido pero no disponible`);
                throw new Error(`STT_INIT_FAILED: audioSource inválido (${audioSource}) - Snoop requerido pero no disponible`);
            }

            // 🎯 VALIDACIÓN ADICIONAL: Verificar que el Snoop realmente existe vía ARI
            try {
                const snoopChannel = ari.Channel();
                const channelState = await snoopChannel.get({ channelId: audioSource });
                if (!channelState || channelState.state === 'Down') {
                    log("error", `❌ [STT INIT] STT no inicializado: Snoop ${audioSource} no existe o está Down`);
                    throw new Error(`STT_INIT_FAILED: Snoop ${audioSource} no existe o está Down`);
                }
            } catch (snoopCheckErr) {
                // Si el Snoop no existe, NO marcar como inicializado
                log("error", `❌ [STT INIT] STT no inicializado: Error verificando Snoop ${audioSource}: ${snoopCheckErr.message}`);
                throw new Error(`STT_INIT_FAILED: Snoop ${audioSource} no disponible: ${snoopCheckErr.message}`);
            }

            // 🎯 CONTRATO: Validar que el Snoop está realmente READY antes de marcar STT como inicializado
            const finalContract = await getSnoopContract(linkedId);
            if (!finalContract || (finalContract.snoopId !== audioSource && audioSource !== channel.id)) {
                log("error", `❌ [STT INIT] STT no inicializado: Contrato no encontrado o snoopId no coincide`, {
                    linkedId,
                    audioSource,
                    contractSnoopId: finalContract?.snoopId
                });
                throw new Error(`STT_INIT_FAILED: Contrato no encontrado o snoopId no coincide`);
            }

            if (finalContract.state !== SnoopState.READY) {
                log("error", `❌ [STT INIT] STT no inicializado: Snoop ${audioSource} no está READY (estado: ${finalContract.state})`, { linkedId, currentPhase });
                throw new Error(`STT_INIT_FAILED: Snoop ${audioSource} no está READY (estado: ${finalContract.state}), requiere READY o ANCHORED`);
            }

            // ✅ REGLA 3: STT init atómico - solo marcar como inicializado si audioSource es válido
            // Verificar que audioSource existe y no es el canal principal
            if (!audioSource || audioSource === channel.id) {
                log("error", `❌ [STT INIT] STT no inicializado: audioSource inválido (${audioSource})`, { linkedId, currentPhase });
                throw new Error(`STT_INIT_ABORT_NO_AUDIO_SOURCE: audioSource=${audioSource} es inválido`);
            }

            // ✅ REGLA 3: Verificar que el contrato tiene snoopId válido
            if (!finalContract.snoopId || finalContract.snoopId !== audioSource) {
                log("error", `❌ [STT INIT] STT no inicializado: Contrato snoopId (${finalContract.snoopId}) no coincide con audioSource (${audioSource})`, { linkedId, currentPhase });
                throw new Error(`STT_INIT_ABORT_CONTRACT_MISMATCH: snoopId=${finalContract.snoopId} !== audioSource=${audioSource}`);
            }

            // ✅ REGLA 3: STT init atómico - marcar TODO junto o nada
            snoopChannelId = audioSource; // 🎯 Guardar Snoop ID PRIMERO
            sttPhaseInitialized = currentPhase; // 🎯 Marcar en qué fase se inicializó
            sttInitialized = true; // 🎯 SOLO AQUÍ - después de todas las validaciones

            // 🎯 Transición del contrato a CONSUMED (STT iniciado)
            // Incluir ExternalMedia en el contrato
            if (audioSource && audioSource !== channel.id && externalChannel) {
                try {
                    await transitionSnoopState(
                        linkedId,
                        SnoopState.READY,
                        SnoopState.CONSUMED,
                        { externalMediaId: externalChannel.id }
                    );
                    log("info", `📜 [SNOOP CONTRACT] Snoop ${audioSource} transicionado a CONSUMED (STT iniciado, externalMedia=${externalChannel.id})`);
                } catch (contractErr) {
                    log("warn", `⚠️ [SNOOP CONTRACT] Error transicionando a CONSUMED: ${contractErr.message} - STT continuará`);
                }
            }

            // 🔥 CRÍTICO: Solo marcar sttInitAttempted DESPUÉS de AUDIO_READY y STT inicializado
            // Esto garantiza que solo se marca cuando realmente hubo éxito, no antes
            sttInitAttempted = true;
            // ✅ FIX: Resetear contador de reintentos cuando STT se inicializa exitosamente
            if (engineState) {
                engineState.sttRetryCount = 0;
            }

            log("info", `✅ [STT] STT inicializado exitosamente para fase ${currentPhase}, Snoop=${snoopChannelId}`);
            log("info", `✅ [STT CONTRACT] audioSource=${snoopChannelId} | phase=${currentPhase} | Snoop RX válido`);
            log("info", "✅ [ENGINE] STT Stack Ready (AUDIO_READY confirmado)");

        } catch (err) {
            // 🎯 MEJORA: Clasificar errores - NO marcar como "intentado" si es error de código
            const isCodeError = err instanceof ReferenceError ||
                err instanceof TypeError ||
                err.message?.includes('before initialization') ||
                err.message?.includes('is not defined') ||
                err.message?.includes('Cannot read property');

            if (isCodeError) {
                log("error", `🔥 [STT BUG] Error lógico en STT init: ${err.message}, permitiendo reintento`);
                log("error", `🔥 [STT BUG] Stack: ${err.stack}`);
                // NO marcar como intentado - permitir reintento
                sttInitAttempted = false;
                sttInitialized = false;
                sttPhaseInitialized = null;
                // Cleanup partials if failed
                if (udpServer) try { udpServer.close(); } catch (cleanupErr) { }
                // ✅ FIX: NO destruir capture bridge si el Snoop está READY (bridge persistente)
                // El bridge debe vivir toda la sesión, no destruirse por errores temporales
                const contract = await getSnoopContract(linkedId);
                const snoopIsReady = contract && (contract.state === SnoopState.READY);
                if (captureBridge && !snoopIsReady) {
                    // Solo destruir si el Snoop NO está READY (error real)
                    try { await captureBridge.destroy(); } catch (cleanupErr) { }
                } else if (captureBridge && snoopIsReady) {
                    log("info", `🔄 [STT INIT] Manteniendo capture bridge ${captureBridge.id} (Snoop READY, bridge persistente)`);
                }
                // Re-lanzar para que el engine pueda reintentar
                throw err;
            }

            // 🛡️ Manejo específico para canales que no existen (hangup temprano) o Snoop no disponible
            // 🎯 FIX: También detectar errores recuperables de Stasis / Snoop no READY
            const isRecoverableStasisError = err.message?.includes('Channel not in Stasis application') ||
                err.message?.includes('ExternalMedia bridge attachment failed (recoverable)') ||
                err.message?.includes('Stasis');
            const isRecoverableSnoopNotReady =
                /STT_BLOCKED_SNOOP_STATE_(CREATED|WAITING_AST|ANCHORED)/.test(err.message || '');

            if (err.message && (
                err.message.includes('Channel not found') ||
                err.message.includes('not available') ||
                err.message.includes('hangup detected') ||
                err.message.includes('STT abortado') ||
                err.message.includes('Snoop')
            )) {
                log("error", `❌ [STT INIT] STT no inicializado: ${err.message}`);
                // 🎯 CRÍTICO: NO marcar como inicializado, NO reinicializar
                // Si estamos en LISTEN_RUT, el gating en el main loop ya maneja esto
                sttInitialized = false;
                sttPhaseInitialized = null;
                // 🎯 FIX: No marcar como intentado si es error recuperable de Stasis o Snoop aún no READY
                if (isRecoverableStasisError || isRecoverableSnoopNotReady) {
                    // CRÍTICO: permitir reintento en el próximo Turn
                    sttInitAttempted = false;
                    log("warn", `⚠️ [STT INIT] Error recuperable detectado (stasis/snoop-not-ready) - sttInitAttempted=false (permitiendo reintento)`);
                } else {
                    sttInitAttempted = true; // Solo marcar como fallido si NO es recuperable
                }
            } else if (isRecoverableStasisError) {
                log("warn", `⚠️ [STT INIT] Error recuperable de Stasis: ${err.message} - Permitir reintento`);
                sttInitialized = false;
                sttPhaseInitialized = null;
                // NO marcar sttInitAttempted = true para permitir reintento
                sttInitAttempted = false;
                // Cleanup partials if failed
                if (udpServer) try { udpServer.close(); } catch (cleanupErr) { }
                // ✅ FIX: NO destruir capture bridge en errores recuperables (bridge persistente)
                // El bridge debe vivir toda la sesión
                log("info", `🔄 [STT INIT] Manteniendo capture bridge (error recuperable, bridge persistente)`);
                // 🎯 NO re-lanzar error - el gating en el main loop manejará el reintento
                throw err; // Re-lanzar para que el gating en el main loop lo maneje
            }
            log("error", `❌ [STT INIT] Failed to initialize STT stack: ${err.message}`);
            // Cleanup partials if failed
            if (udpServer) try { udpServer.close(); } catch (cleanupErr) { }
            // ✅ FIX: NO destruir capture bridge en errores fatales (bridge persistente)
            // El bridge debe vivir toda la sesión, solo destruirlo en StasisEnd
            const contract = await getSnoopContract(linkedId);
            const snoopIsReady = contract && (contract.state === SnoopState.READY);
            if (captureBridge && !snoopIsReady) {
                // Solo destruir si el Snoop NO está READY (error real)
                try { await captureBridge.destroy(); } catch (cleanupErr) { }
            } else if (captureBridge && snoopIsReady) {
                log("info", `🔄 [STT INIT] Manteniendo capture bridge ${captureBridge.id} (Snoop READY, bridge persistente)`);
            }
            // 🎯 CRÍTICO: NO marcar como inicializado si falla
            sttInitialized = false;
            sttPhaseInitialized = null;
            throw err; // Re-throw to handle in caller
        } finally {
            sttInitializing = false; // 🎯 SINGLETON LOCK RELEASE
        }
    };

    channel.on("StasisEnd", async () => {
        log("info", `👋 Channel hangup ${linkedId}`);

        // 🧹 Limpieza correcta al salir de LISTEN_RUT / hangup
        // 🎯 Usar contrato formal para liberar Snoop
        try {
            const contract = await getSnoopContract(linkedId);
            if (contract) {
                if (contract.state === SnoopState.CONSUMED) {
                    await releaseSnoop(linkedId);
                    log("info", `📜 [SNOOP CONTRACT] Snoop ${contract.snoopId} liberado (CONSUMED → RELEASABLE)`);
                }
                await destroySnoop(linkedId);
                log("info", `📜 [SNOOP CONTRACT] Snoop ${contract.snoopId} destruido`);
            }
        } catch (contractErr) {
            log("warn", `⚠️ [SNOOP CONTRACT] Error en cleanup: ${contractErr.message}`);
        }

        // 🧹 Limpieza legacy (compatibilidad)
        await redis.del(`snoop:active:${linkedId}`);
        log("info", `🧹 [SNOOP] Protección removida para ${linkedId}`);

        // Cleanup Registry
        const finalMeta = activeSessions.get(linkedId);
        activeSessions.delete(linkedId);
        if (channel.id) activeSessions.delete(channel.id);

        // 🎯 AUDIO MARKS: Resolver segmentos finales y limpiar
        if (audioCtx?.audioMarks && audioCtx.audioMarks.length > 0) {
            const segments = resolveAudioSegments(audioCtx.audioMarks);
            log("info", "[AUDIO_SEGMENTS_RESOLVED]", {
                linkedId: audioCtx.linkedId,
                totalMarks: audioCtx.audioMarks.length,
                segments: segments,
                activeSegment: getActiveSegment(audioCtx.audioMarks)
            });
        }

        // Limpiar marcas de Redis
        await clearAudioMarks(linkedId, redis);

        engineState.active = false;
        openaiClient.disconnect();

        // 🎙️ CLEANUP: Detener grabación continua y segmenter (si está habilitado)
        if (USE_SEGMENTED_STT) {
            try {
                // Remover listeners de talking
                if (segmenter && segmenter._talkingHandlers) {
                    ari.removeListener("ChannelTalkingStarted", segmenter._talkingHandlers.start);
                    ari.removeListener("ChannelTalkingFinished", segmenter._talkingHandlers.end);
                }

                // Cerrar ventana y forzar flush de segmento pendiente
                if (segmenter) {
                    await segmenter.cleanup();
                    log("info", `🧹 [SEGMENTER] Cleanup completado`);
                }

                // Detener grabación continua
                if (continuousRecorder && segmentStore) {
                    const recMeta = await segmentStore.getRecMeta(linkedId);
                    if (recMeta && recMeta.recordingName) {
                        try {
                            // Usar el método stop del recorder
                            await continuousRecorder.stop({ recording: { name: recMeta.recordingName } });
                            log("info", `🛑 [RECORDING] Grabación continua detenida: ${recMeta.recordingName}`);
                        } catch (stopErr) {
                            if (!stopErr.message.includes('not found') && !stopErr.message.includes('does not exist')) {
                                log("warn", `⚠️ [RECORDING] Error deteniendo grabación continua: ${stopErr.message}`);
                            }
                        }
                    }
                }

                // Detener cola STT
                if (sttQueue) {
                    await sttQueue.stop();
                }
            } catch (cleanupErr) {
                log("error", `❌ [RECORDING] Error en cleanup de grabación continua: ${cleanupErr.message}`);
            }
        }

        if (udpServer) {
            try { udpServer.close(); } catch (e) { } // Stop UDP listener
        }
        if (captureBridge) {
            try {
                await captureBridge.destroy();
                log("info", `🌉 [BRIDGE] Bridge ${captureBridge.id} destruido en StasisEnd`);
            } catch (err) {
                log("error", `❌ Error destruyendo bridge en StasisEnd: ${err.message}`);
            }
        }
        if (externalChannel) {
            try {
                // External channel usually dies with the bridge/main channel, but good ensuring hangup
                await externalChannel.hangup();
            } catch (e) { }
        }
        if (voiceBridgeRef.current) {
            try {
                // 🎯 LIFECYCLE GOVERNANCE: Verificar si el teardown está permitido
                const currentPhase = await redis.get(`phase:${linkedId}`) || 'END_CALL';
                const bridgeId = voiceBridgeRef.current.id;

                log("info", `🔒 [LIFECYCLE] Verificando teardown de bridge en StasisEnd: phase=${currentPhase}, bridgeId=${bridgeId}, linkedId=${linkedId}`);

                // 📊 LOG DETALLADO: Estado del bridge antes de destruir
                try {
                    const bridgeState = await voiceBridgeRef.current.get();
                    log("info", `🔒 [LIFECYCLE] Estado del bridge antes de teardown:`, {
                        bridgeId: bridgeId,
                        bridgeType: bridgeState.bridge_type,
                        channels: bridgeState.channels || [],
                        channelCount: bridgeState.channels?.length || 0,
                        phase: currentPhase
                    });
                } catch (stateErr) {
                    log("warn", `⚠️ [LIFECYCLE] Error obteniendo estado del bridge antes de teardown: ${stateErr.message}`);
                }

                // ✅ FIX: Durante StasisEnd, siempre permitir teardown (la sesión está terminando)
                // El contrato de fase aplica durante operación normal, no durante cleanup
                const teardownAllowed = isTeardownAllowed(currentPhase, { bridgeId, linkedId, reason: 'stasis-end' });
                const allowTeardownInStasisEnd = true; // Siempre permitir durante StasisEnd

                if (!teardownAllowed && !allowTeardownInStasisEnd) {
                    log("warn", `🔒 [LIFECYCLE] ❌ Teardown de bridge ${bridgeId} BLOQUEADO en fase ${currentPhase} - Bridge NO será destruido`);
                    // No destruir el bridge si la fase no lo permite (solo en operación normal)
                } else {
                    log("info", `🔒 [LIFECYCLE] ✅ Teardown PERMITIDO en fase ${currentPhase} (StasisEnd) - Procediendo a destruir bridge ${bridgeId}`);
                    await voiceBridgeRef.current.destroy();
                    log("info", `🌉 [VOICE BRIDGE] ✅ Bridge de voz ${bridgeId} destruido exitosamente en StasisEnd (fase: ${currentPhase})`);
                }
            } catch (err) {
                log("error", `❌ [LIFECYCLE] Error destruyendo voice bridge en StasisEnd: ${err.message}`, {
                    error: err.message,
                    stack: err.stack,
                    linkedId: linkedId
                });
            }
        } else {
            log("debug", `🔒 [LIFECYCLE] No hay voiceBridgeRef.current en StasisEnd (linkedId=${linkedId})`);
        }
    });

    // =======================================================
    // 🚀 INITIALIZATION (INIT EVENT)
    // =======================================================
    try {
        // 🛡️ VALIDACIÓN CRÍTICA: Verificar que domainContext existe antes de usarlo
        if (!domainContext) {
            throw new Error("domainContext is not defined - cannot proceed with INIT event");
        }

        if (!domainContext.domain || typeof domainContext.domain !== 'function') {
            throw new Error(`domainContext.domain is not a function (type: ${typeof domainContext.domain})`);
        }

        log("info", `📢 [ENGINE] Sending INIT event`, {
            domainContextExists: !!domainContext,
            domainFunctionExists: typeof domainContext.domain === 'function',
            domainName: domainContext.domainName || 'unknown',
            hasState: !!domainContext.state
        });

        const initCtx = buildDomainCtx("", domainContext, ari, channel, ani, dnis, linkedId);

        // 1️⃣ SEND INIT EVENT
        const initResult = await domainContext.domain({
            ...initCtx,
            event: 'INIT'
        });

        // ⚡ STT PRE-WARM (On INIT) - ANTES de aplicar resultado para tener nextPhase disponible
        // Si el INIT se va a PLAY_AUDIO (skipInput=true), igual conviene pre-calentar STT en background
        // cuando la próxima fase es LISTEN_* para evitar perder los primeros 600–800ms.
        const listenPhases = new Set(['LISTEN_RUT', 'LISTEN_OPTION', 'LISTEN_CONFIRMATION']);
        // 🎯 CRÍTICO: Usar nextPhase del dominio ANTES de normalización
        // El adapter puede sobrescribir nextPhase cuando action=PLAY_AUDIO, pero el dominio ya indicó la siguiente fase
        // Necesitamos acceder al nextPhase original del dominio antes de que el adapter lo normalice
        // El dominio puede poner nextPhase directamente o en la propiedad phase
        // 🚨 FIX: El adapter normaliza nextPhase a la fase actual cuando action=PLAY_AUDIO,
        // pero el dominio ya indicó nextPhase="LISTEN_RUT" en el trace. Necesitamos usar el trace o el resultado original.
        const intendedNextPhase = initResult?.nextPhase || initResult?.phase;
        // 🎯 FIX ADICIONAL: Si el adapter normalizó nextPhase pero el dominio dijo LISTEN_RUT, detectarlo
        // Revisar si hay evidencia de que el dominio quería LISTEN_RUT (enableIncremental es un indicador)
        const domainWantsListenRut = initResult?.enableIncremental === true ||
            (initResult?.action === 'PLAY_AUDIO' && initResult?.nextPhase === 'LISTEN_RUT') ||
            (initResult?.action?.type === 'PLAY_AUDIO' && initResult?.nextPhase === 'LISTEN_RUT');
        const willSkipInput = (initResult?.skipInput === true || initResult?.skipUserInput === true);
        const isSilent = initResult?.silent === true;

        // 🎯 MEJORA FLUIDEZ: Pre-warm mejorado para mantener sesión persistente
        // Pre-warm si: (1) nextPhase es LISTEN_*, o (2) enableIncremental está activo, o (3) el dominio indica que viene LISTEN_RUT
        // 🎯 NUEVO: También pre-warm durante greeting (silent=true) si nextPhase es LISTEN_RUT
        const shouldPrewarm =
            sttMode === 'realtime' &&
            (listenPhases.has(intendedNextPhase) ||
                initResult?.enableIncremental === true ||
                domainWantsListenRut); // Pre-warm si el dominio quiere LISTEN_RUT

        log("info", `🔍 [ENGINE] Pre-warm check: sttMode=${sttMode}, intendedNextPhase=${intendedNextPhase}, normalizedNextPhase=${initResult?.nextPhase}, enableIncremental=${initResult?.enableIncremental}, domainWantsListenRut=${domainWantsListenRut}, shouldPrewarm=${shouldPrewarm}, willSkipInput=${willSkipInput}, isSilent=${isSilent}`);

        // ✅ ARQUITECTURA DESACOPLADA: Inicializar STT temprano si está habilitado
        // Esto garantiza que el canal de entrada siempre esté activo, independiente de la fase
        // 🎯 REFACTOR: RESTORED PRE-WARM (TIMING GOVERNANCE)
        // User confirmed that JIT-only approaches cause latency (loss of first word).
        // We restore Early Init but with Strict Guards (Anti-Ghost) to ensure physical readiness.
        const shouldInitEarly = sttMode === 'realtime' && !sttInitialized;

        if (shouldInitEarly) {
            // 🎯 EARLY INIT (ASYNC): Preparar canal de entrada SIN bloquear playback
            // Motivo: START_GREETING niega STT por contrato de lifecycle; además, STT requiere Snoop READY.
            // Aquí solo dejamos el Snoop RX listo (READY) + captureBridge creado/anclado.
            // 🚨 CRÍTICO: NO bloquear el playback - ejecutar en background
            log("info", `🔥 [ENGINE] Early INPUT preparation - Snoop/captureBridge (sin STT en START_GREETING) - ASYNC`);

            // 🎯 FIX: Ejecutar en background para no bloquear playback
            (async () => {
                try {
                    // Crear capture bridge temprano (si no existe)
                    if (!captureBridge) {
                        captureBridge = ari.Bridge();
                        await captureBridge.create({ type: 'mixing,dtmf_events' });
                        log("info", `🌉 [BRIDGE] Bridge de captura creado temprano ${captureBridge.id}`);
                    }

                    // Crear Snoop temprano si no existe
                    if (!domainContext.audioChannelId || domainContext.audioChannelId === channel.id) {
                        log("info", `🕵️‍♂️ [ENGINE] Creando Snoop RX temprano para canal de entrada persistente...`);
                        const SNOOP_APP = "media-snoop";
                        const appArgs = `linkedId=${linkedId}`;

                        // ✅ LOG 1: Creación del Snoop (fuente de verdad) - EARLY INIT
                        log("info", "🕵️‍♂️ [SNOOP CREATE] Creando Snoop temprano (early init)", {
                            snoopId: "pending",
                            parentChannelId: channel.id,
                            linkedId,
                            app: SNOOP_APP,
                            appArgs,
                            spy: 'in',
                            whisper: 'none',
                            reason: "early_init_pre_warm"
                        });

                        // ✅ PRIORIDAD 1: Pasar appArgs efectivos para correlación correcta
                        const newSnoop = await ari.channels.snoopChannel({
                            channelId: channel.id,
                            app: SNOOP_APP,
                            appArgs: appArgs, // ✅ FIX: Pasar appArgs para correlación
                            spy: 'in',
                            whisper: 'none'
                        });

                        // ✅ PRIORIDAD 4: Log decisivo de creación
                        log("info", "📊 [SNOOP_CREATE_RESULT]", {
                            snoopId: newSnoop.id,
                            parentChannelId: channel.id,
                            linkedId,
                            appArgs,
                            app: SNOOP_APP,
                            ts: Date.now()
                        });

                        // ✅ LOG 1: Confirmación de creación con ID real
                        log("info", "🕵️‍♂️ [SNOOP CREATE] Snoop temprano creado exitosamente", {
                            snoopId: newSnoop.id,
                            parentChannelId: channel.id,
                            linkedId,
                            app: SNOOP_APP,
                            appArgs,
                            timestamp: Date.now()
                        });

                        // Crear contrato en CREATED
                        await createSnoopContract(linkedId, newSnoop.id, channel.id);

                        // ✅ PRIORIDAD 0: AUDIO PLANE PINNING (Anti-Race & Anti-Zombie)
                        // Usar el controlador de plano de audio p/ garantizar existencia física antes de nada
                        try {
                            // 1. WAIT SIGNALING (StasisStart) ==> Source of Truth for "Existence"
                            await waitForAsteriskReady(ari, newSnoop.id, linkedId);

                            // 2. PIN SNOOP (Audio Plane Anchor) - Post Stasis
                            // 1. PIN SNOOP (Aggressive Loop): Anclar al bridge para evitar GC
                            const pinned = await AudioPlaneController.pinSnoopToBridge(captureBridge, newSnoop.id);

                            if (pinned) {
                                // 🎯 ADR-002: NO transicionar a ANCHORED. Mantener en READY.
                                // La existencia física (pin) es un atributo del plano de audio, no del contrato lógico.
                                log("info", `📌 [AUDIO_PLANE] Snoop ${newSnoop.id} anclado exitosamente (Post-Stasis Pin)`);
                            } else {
                                log("warn", `⚠️ [AUDIO_PLANE] Falló anclaje de Snoop ${newSnoop.id} tras loops - Riesgo de GC`);
                                // Mantener en READY (riesgoso pero operativo)
                            }

                            // 3. VERIFY PHYSICAL (Audio Plane Ready Loop)
                            // Garantiza que canales.get() funciona antes de marcar READY
                            const planeReady = await AudioPlaneController.waitForAudioPlaneReady(ari, newSnoop.id, 2500);

                            if (planeReady) {
                                log("info", `✅ [AUDIO_PLANE] Plano de Audio TOTALMENTE LISTO (Pinned + Stasis + Physical Up)`);
                                // Ya estamos en READY (por StasisStart), no es necesaria transición
                                domainContext.audioChannelId = newSnoop.id;
                            } else {
                                log("error", `❌ [AUDIO_PLANE] Snoop ${newSnoop.id} falló verificación física final - Marcando defectuoso`);
                                // TODO: Marcar como DEFECTIVE o forzar recreación
                            }
                        } catch (ctrlErr) {
                            log("error", `❌ [AUDIO_PLANE] Error crítico en inicialización temprana: ${ctrlErr.message}`);
                        }

                    }
                } catch (unknownErr) {
                    log("error", `❌ [ENGINE] Unhandled error in background prep: ${unknownErr.message}`);
                }
            })(); // 🎯 Ejecutar en background - NO await
        }

        if (shouldPrewarm && !sttInitialized) {
            // 🎯 MEJORA: Pre-warm con retry logic (solo si no se inicializó temprano)
            const preWarmWithRetry = async (maxRetries = 2) => {
                for (let i = 0; i < maxRetries; i++) {
                    try {
                        await ensureSTT();
                        return true;
                    } catch (e) {
                        if (i < maxRetries - 1) {
                            const delay = 500 * (i + 1); // Backoff: 500ms, 1000ms
                            log("debug", `🔄 [ENGINE] Pre-warm retry ${i + 1}/${maxRetries} en ${delay}ms...`);
                            await new Promise(resolve => setTimeout(resolve, delay));
                        } else {
                            log("warn", `⚠️ [ENGINE] Pre-warm falló después de ${maxRetries} intentos`);
                        }
                    }
                }
                return false;
            };

            if (willSkipInput || isSilent) {
                // 🎯 MEJORA: Pre-warm durante playback/greeting para mantener sesión persistente
                // Esto reduce latencia cuando se transiciona a LISTEN_RUT
                log("info", `🔥 [ENGINE] Pre-warming STT during playback/greeting (intendedNextPhase=${intendedNextPhase || 'UNKNOWN'}, domainWantsListenRut=${domainWantsListenRut}, silent=${isSilent})`);
                // 🛡️ Pre-warm en background para no bloquear el playback
                const preWarmFailedKey = `stt:prewarm:failed:${linkedId}`;
                const hasRecentFailure = await redis.get(preWarmFailedKey);

                if (!hasRecentFailure) {
                    preWarmWithRetry().then((success) => {
                        if (!success) {
                            redis.set(preWarmFailedKey, 'true', { EX: 60 }); // No intentar por 60s
                            sttInitialized = false;
                            sttPhaseInitialized = null;
                        }
                    }).catch((e) => {
                        if (e.message && (e.message.includes('Channel not found') || e.message.includes('not available') || e.message.includes('hangup detected'))) {
                            log("warn", `⚠️ [ENGINE] STT pre-warm failed: Canal Snoop no disponible aún (will retry on listen): ${e.message}`);
                        } else {
                            log("warn", `⚠️ [ENGINE] STT pre-warm failed (will retry on listen): ${e.message}`);
                        }
                        sttInitialized = false;
                        sttPhaseInitialized = null;
                    });
                } else {
                    log("debug", `⏭️ [ENGINE] Pre-warm omitido: fallo reciente detectado (60s cooldown)`);
                }
            } else {
                await ensureSTT();
            }
        } else if (shouldPrewarm && sttInitialized) {
            log("debug", `⏭️ [ENGINE] Pre-warm skipped: STT ya inicializado temprano`);
        } else {
            log("debug", `⏭️ [ENGINE] Pre-warm skipped: sttMode=${sttMode}, intendedNextPhase=${intendedNextPhase}, normalizedNextPhase=${initResult?.nextPhase}, enableIncremental=${initResult?.enableIncremental}, domainWantsListenRut=${domainWantsListenRut}`);
        }

        // 2️⃣ UPDATE STATE (PARCIAL - NO actualizar fase aún)
        // 🎯 CRÍTICO: NO actualizar la fase ANTES de ejecutar el playback
        // El playback debe ejecutarse en la fase ACTUAL (START_GREETING), no en la siguiente
        if (initResult) {
            if (initResult.state) {
                // Preservar la fase actual temporalmente para el playback
                const currentPhaseBeforeUpdate = domainContext.state?.rutPhase || INITIAL_PHASE;
                domainContext.state = { ...domainContext.state, ...initResult.state };
                // 🎯 TEMPORAL: Mantener fase actual para playback, luego actualizar
                domainContext.state.rutPhase = currentPhaseBeforeUpdate;
                log("info", `🔒 [LIFECYCLE] Preservando fase ${currentPhaseBeforeUpdate} para ejecutar playback antes de cambiar a ${initResult.nextPhase || 'unknown'}`);
            }
            // Check for silent transition immediately
            // IMPORTANT: "silent" is for barge-in/playback protection, NOT for skipping STT.
            // If a domain wants to skip input, it must set skipInput (or skipUserInput) explicitly.
            engineState.skipInput = willSkipInput;
            domainContext.lastResult = initResult;
        }

        // 🎯 CONTRATO INCREMENTAL: Ejecutar flags del dominio en INIT también
        if (initResult && openaiClient.enableIncremental && openaiClient.disableIncremental) {
            if (initResult.enableIncremental === true) {
                openaiClient.enableIncremental();
                log("info", "🎯 [ENGINE] Incremental activado por dominio (INIT)");
            }
            if (initResult.disableIncremental === true) {
                openaiClient.disableIncremental();
                log("info", "🎯 [ENGINE] Incremental desactivado por dominio (INIT)");
            }
        }

        // 🎯 EJECUTAR PLAYBACK EN FASE ACTUAL (antes de cambiar de fase)
        await applyDomainResult(initResult, openaiClient, conversationState, ari, channel, captureBridge, voiceBridgeRef, domainContext);

        // 🎯 ACTUALIZAR FASE DESPUÉS del playback (si hay nextPhase)
        if (initResult?.nextPhase && initResult.nextPhase !== domainContext.state?.rutPhase) {
            const { isValidPhase } = await import('./lifecycle-contract.js');
            const previousPhase = domainContext.state?.rutPhase || INITIAL_PHASE;
            if (isValidPhase(initResult.nextPhase)) {
                domainContext.state = domainContext.state || {};
                domainContext.state.rutPhase = initResult.nextPhase;
                await redis.set(`phase:${linkedId}`, initResult.nextPhase, { EX: 3600 });
                log("info", `🔒 [LIFECYCLE] Fase actualizada DESPUÉS del playback: ${previousPhase} → ${initResult.nextPhase} (linkedId=${linkedId})`, {
                    previousPhase: previousPhase,
                    newPhase: initResult.nextPhase,
                    validated: true
                });
            }
        }

        if (initResult?.shouldHangup || initResult?.action === 'HANGUP') {
            // 🛠️ FIX 3: TERMINATION GUARD (Phase 3+)
            // Prevent hangup if we are in Phase 3 and don't have a RUT yet.
            // This prevents "End Call" on logic errors or ghosts.
            const currentPhase = parseInt(domainContext.state?.rutPhase || 0, 10);
            const hasRut = !!(domainContext.state?.rut || domainContext.state?.rut_valid); // Check state for RUT

            if (currentPhase >= 3 && !hasRut) {
                log("warn", `🛡️ [ENGINE] Prevented session end in Phase ${currentPhase}: RUT missing`);
                // Force a safe state instead of ending
                // We can't easily force "loop back" here without loop context, but we can prevent 'active=false'
                // and prioritize a retry action if possible. 
                // For INIT path, we just don't set active=false.
            } else {
                engineState.active = false;
            }
        }

        // 🛠️ FIX 2: PHASE PERSISTENCE + ENFORCEMENT
        // 🎯 NOTA: La fase se actualiza DESPUÉS del playback (ver código arriba)
        // Esto garantiza que el playback se ejecute en la fase correcta

    } catch (err) {
        log("error", `❌ Init error: ${err.message}`, {
            errorType: err.constructor.name,
            errorMessage: err.message,
            errorStack: err.stack,
            domainContextExists: typeof domainContext !== 'undefined',
            domainContextType: typeof domainContext,
            domainContextHasDomain: domainContext && typeof domainContext.domain !== 'undefined',
            domainContextDomainType: domainContext && typeof domainContext.domain
        });
        engineState.active = false;
    }

    // =======================================================
    // 🔄 MAIN LOOP
    // =======================================================
    while (engineState.active && engineState.turn < MAX_TURNS) {
        engineState.turn++;
        log("info", `🔄 Turn ${engineState.turn}`);
        // 🔍 DEBUG: Trace Engine Decision
        // 🎯 FIX 4: Usar fase REAL del engine (desde Redis), NO domainContext.state
        const currentPhase = await redis.get(`phase:${linkedId}`) || domainContext.state?.rutPhase || 'UNKNOWN';

        // 🛠️ FIX: SILENT TURN ON PHASE CHANGE
        // Detect phase transition and FORCE skipInput=false for listening phases
        // This prevents "Empty Transcript" issues after playback transitions
        if (engineState.lastPhase && engineState.lastPhase !== currentPhase) {
            const listeningPhases = ['LISTEN_RUT', 'LISTEN_OPTION', 'LISTEN_CONFIRMATION'];
            if (listeningPhases.includes(currentPhase)) {
                log("info", `🔄 [ENGINE] Phase Change detected (${engineState.lastPhase} -> ${currentPhase}) - Forcing skipInput=false to ensure LISTENING`);
                engineState.skipInput = false;
            }
        }
        engineState.lastPhase = currentPhase;

        log("debug", `[ENGINE][TURN ${engineState.turn}] phase=${currentPhase} silent=${domainContext.lastResult?.silent} skipInput=${engineState.skipInput}`);

        let transcript = "";

        // 🛑 SILENT MODE CHECK
        log("info", `[ENGINE][LISTEN_CHECK] phase=${currentPhase} skipInput=${engineState.skipInput}`);
        log("debug", `[ENGINE][STT_DECISION] phase=${currentPhase} skipInput=${engineState.skipInput} silent=${domainContext.lastResult?.silent} action=${domainContext.lastResult?.action}`);

        // 🛠️ FIX 7: FORCE LISTENING FOR BVDA/IMMEDIATE INPUT PHASES
        // "BVDA-driven flows must force immediate listening after playback. Legacy silent turns are disabled for LISTEN_ phases."
        if (engineState.skipInput && (currentPhase === 'LISTEN_RUT' || currentPhase === 'LISTEN_OPTION' || currentPhase === 'LISTEN_CONFIRMATION')) {
            log("info", `🔓 [ENGINE] Forcing LISTEN for phase ${currentPhase} (Overriding skipInput)`);
            engineState.skipInput = false;
        }

        if (engineState.skipInput) {
            log("warn", `[ENGINE][SKIP_LISTEN] phase=${domainContext.state?.rutPhase} reason=skipInput`);
            log("info", "⏩ [ENGINE] Silent Turn: Skipping Input & STT");
            engineState.skipInput = false; // Reset, domain must re-assert silent each time if needed
        } else {
            // 👂 NORMAL LISTENING MODE

            // 🎯 FIX 4: Usar fase REAL del engine (desde Redis)
            const currentPhase = await redis.get(`phase:${linkedId}`) || domainContext.state?.rutPhase || 'UNKNOWN';

            // 🎯 GATING ESTRICTO: STT solo puede inicializarse una vez por fase LISTEN_RUT
            if (currentPhase === 'LISTEN_RUT' || currentPhase === 'LISTEN_OPTION' || currentPhase === 'LISTEN_CONFIRMATION') {
                // 🛡️ Si ya se intentó STT para esta fase y falló, verificar si es recuperable
                if (sttInitAttempted && !sttInitialized) {
                    // 🔥 FIX: Verificar si el error fue recuperable
                    // Si el contrato está READY pero channels.get() falló, es recuperable (retry con backoff)
                    const snoopContract = await getSnoopContract(linkedId);
                    const contractIsReady = snoopContract &&
                        (snoopContract.state === SnoopState.READY ||
                            snoopContract.state === SnoopState.CONSUMED);

                    const isRecoverableSnoopIssue = snoopContract &&
                        (snoopContract.state === SnoopState.CREATED ||
                            snoopContract.state === SnoopState.WAITING_AST ||
                            contractIsReady); // ✅ READY también es recuperable (puede ser channels.get() timing)

                    // ✅ FIX: Permitir reintentos limitados (máximo 3 intentos) con backoff
                    const maxRetries = 3;
                    const retryCount = engineState.sttRetryCount || 0;

                    if (isRecoverableSnoopIssue && retryCount < maxRetries) {
                        engineState.sttRetryCount = (engineState.sttRetryCount || 0) + 1;
                        const backoffMs = Math.min(500 * engineState.sttRetryCount, 2000); // 500ms, 1000ms, 2000ms
                        log("info", `🔄 [STT INIT] Error recuperable detectado (Snoop state=${snoopContract.state}, intento ${engineState.sttRetryCount}/${maxRetries}) - Reintentando después de ${backoffMs}ms`);
                        sttInitAttempted = false; // Resetear para permitir reintento
                        await new Promise(resolve => setTimeout(resolve, backoffMs));
                        // Continuar al bloque de inicialización
                    } else if (retryCount >= maxRetries) {
                        log("warn", `⛔ [STT INIT] Máximo de reintentos alcanzado (${maxRetries}) para ${currentPhase}. No reintentando.`);
                        log("warn", `⛔ [ENGINE] STT no inicializado en ${currentPhase} - Bloqueando avance de turnos hasta timeout o input`);
                        const listenTimeout = domainContext.lastResult?.config?.listenTimeout || config.audio.maxWaitMs || 4000;
                        log("info", `⏳ [ENGINE] Esperando ${listenTimeout}ms por input o timeout antes de continuar...`);
                        await new Promise(resolve => setTimeout(resolve, Math.min(listenTimeout, 2000)));
                        engineState.silentCount++;
                        continue;
                    } else {
                        log("warn", `⛔ [STT INIT] Ya se intentó STT para ${currentPhase} y falló (no recuperable, Snoop state=${snoopContract?.state || 'MISSING'}). No reintentando.`);
                        log("warn", `⛔ [ENGINE] STT no inicializado en ${currentPhase} - Bloqueando avance de turnos hasta timeout o input`);
                        const listenTimeout = domainContext.lastResult?.config?.listenTimeout || config.audio.maxWaitMs || 4000;
                        log("info", `⏳ [ENGINE] Esperando ${listenTimeout}ms por input o timeout antes de continuar...`);
                        await new Promise(resolve => setTimeout(resolve, Math.min(listenTimeout, 2000)));
                        engineState.silentCount++;
                        continue;
                    }
                }

                // 🎯 Solo intentar STT si no se ha intentado aún para esta fase
                if (!sttInitAttempted) {
                    // 📊 LOG DETALLADO: Estado antes de validar STT
                    log("info", `🔒 [LIFECYCLE] Pre-validación STT: phase=${currentPhase}, sttInitAttempted=${sttInitAttempted}, sttInitialized=${sttInitialized}, channelId=${channel.id}, linkedId=${linkedId}`);

                    // 🎯 LIFECYCLE GOVERNANCE: Verificar si STT está permitido en esta fase
                    const sttAllowed = await isActionAllowed(currentPhase, 'STT', {
                        channelId: channel.id,
                        linkedId: linkedId,
                        sttInitAttempted: sttInitAttempted,
                        sttInitialized: sttInitialized
                    });

                    if (!sttAllowed) {
                        log("warn", `🔒 [LIFECYCLE] ❌ STT BLOQUEADO en fase ${currentPhase} - No se inicializará STT`);
                        sttInitAttempted = true; // Marcar como intentado para no reintentar
                        continue;
                    }

                    // 🎯 LIFECYCLE GOVERNANCE: Verificar si Snoop es requerido
                    const snoopRequired = isResourceRequired(currentPhase, 'SNOOP', {
                        channelId: channel.id,
                        linkedId: linkedId
                    });

                    if (snoopRequired) {
                        log("info", `🔒 [LIFECYCLE] ✅ Snoop REQUERIDO en fase ${currentPhase}`);
                    }

                    // 📊 LOG DETALLADO: Contrato completo de la fase
                    const phaseContract = getPhaseContract(currentPhase, true);

                    // 🔥 CRÍTICO: NO marcar sttInitAttempted aquí - solo después de AUDIO_READY y STT exitoso
                    // sttInitAttempted se marca dentro de ensureSTT() después de inicialización exitosa
                    log("info", `🔌 [ENGINE] Initializing STT Stack (${currentPhase})...`);
                    log("info", `🔒 [LIFECYCLE] ✅ STT PERMITIDO: phase=${currentPhase}, allowsSTT=true, requiresSNOOP=${snoopRequired}, contract=${JSON.stringify(phaseContract ? { allow: phaseContract.allow, deny: phaseContract.deny, requires: phaseContract.requires } : 'null')}`);

                    // 🎯 CRÍTICO: Verificar que el caller esté en el voice bridge antes de crear Snoop
                    // El bridge es el bus de audio del bot y DEBE estar activo para LISTEN_RUT
                    if (voiceBridgeRef?.current) {
                        try {
                            const bridgeInfo = await voiceBridgeRef.current.get();
                            const callerInBridge = Array.isArray(bridgeInfo.channels) &&
                                bridgeInfo.channels.includes(channel.id);

                            if (!callerInBridge) {
                                log("warn", `⚠️ [VOICE BRIDGE] Caller ${channel.id} NO está en bridge ${voiceBridgeRef.current.id} antes de LISTEN_RUT, reinsertando...`);
                                await voiceBridgeRef.current.addChannel({ channel: channel.id });

                                // Verificar después de re-insertar
                                const verifyBridge = await voiceBridgeRef.current.get();
                                const verifyChannels = Array.isArray(verifyBridge.channels) ? verifyBridge.channels : [];
                                const verifyInBridge = verifyChannels.includes(channel.id);

                                log("info", `🔒 [LIFECYCLE] Verificación post-reinserción:`, {
                                    bridgeId: voiceBridgeRef.current.id,
                                    channelId: channel.id,
                                    channelsInBridge: verifyChannels,
                                    channelCount: verifyChannels.length,
                                    callerInBridge: verifyInBridge,
                                    phase: currentPhase
                                });

                                if (verifyInBridge) {
                                    log("info", `✅ [VOICE BRIDGE] Caller ${channel.id} reinsertado exitosamente en bridge ${voiceBridgeRef.current.id} antes de LISTEN_RUT`);
                                } else {
                                    log("error", `❌ [VOICE BRIDGE] Falló reinsertar caller ${channel.id} en bridge ${voiceBridgeRef.current.id} antes de LISTEN_RUT - channels=${JSON.stringify(verifyChannels)}`);
                                }
                            } else {
                                log("info", `✅ [VOICE BRIDGE] Caller ${channel.id} confirmado en bridge ${voiceBridgeRef.current.id} antes de LISTEN_RUT`, {
                                    bridgeId: voiceBridgeRef.current.id,
                                    channelId: channel.id,
                                    channelsInBridge: Array.isArray(bridgeInfo.channels) ? bridgeInfo.channels : [],
                                    phase: currentPhase
                                });
                            }
                        } catch (bridgeErr) {
                            log("error", `❌ [VOICE BRIDGE] Error verificando bridge antes de LISTEN_RUT: ${bridgeErr.message}`);
                        }
                    }

                    // 🎯 CRÍTICO: Crear Snoop justo antes de LISTEN_RUT si no existe
                    // El Snoop debe pertenecer al lifecycle de LISTEN_RUT, no a StasisStart
                    if (!domainContext.audioChannelId || domainContext.audioChannelId === channel.id) {
                        // ✅ FIX: Snoop persistente - NO crear nuevo Snoop si ya existe uno
                        // El Snoop es un recurso de SESIÓN, no de fase
                        // Verificar si ya existe un Snoop antes de crear uno nuevo
                        const existingContract = await getSnoopContract(linkedId);
                        const snoopExists = existingContract &&
                            existingContract.state !== SnoopState.DESTROYED &&
                            existingContract.state !== SnoopState.RELEASABLE;

                        if (snoopExists) {
                            // ✅ Snoop persistente ya existe - NO recrear
                            log("info", `🔄 [ENGINE] Snoop persistente ya existe (state=${existingContract.state}) - NO recrear para ${currentPhase}`, {
                                snoopId: existingContract.snoopId,
                                linkedId,
                                phase: currentPhase
                            });
                            // Usar el Snoop existente
                            domainContext.audioChannelId = existingContract.snoopId;
                        } else {
                            // 🎯 LIFECYCLE GOVERNANCE: Verificar si crear Snoop está permitido
                            const createSnoopAllowed = await isActionAllowed(currentPhase, 'CREATE_SNOOP', {
                                channelId: channel.id,
                                linkedId: linkedId,
                                domainContextAudioChannelId: domainContext.audioChannelId,
                                phase: currentPhase
                            });

                            if (!createSnoopAllowed) {
                                log("warn", `🔒 [LIFECYCLE] ❌ Crear Snoop BLOQUEADO en fase ${currentPhase} - Continuando sin Snoop (fallback a canal principal)`);
                                // Continuar sin Snoop - el fallback al canal principal se manejará en ensureSTT
                            } else {
                                try {
                                    log("info", `🕵️‍♂️ [ENGINE] Creando Snoop RX para ${currentPhase}...`);
                                    log("info", `🔒 [LIFECYCLE] ✅ CREATE_SNOOP PERMITIDO: phase=${currentPhase}, channelId=${channel.id}, linkedId=${linkedId}`);
                                    const SNOOP_APP = "media-snoop";
                                    const appArgs = `linkedId=${linkedId}`;
                                    const snoopCreateStart = Date.now();

                                    // ✅ LOG 1: Creación del Snoop (fuente de verdad) - LISTEN_RUT
                                    log("info", "🕵️‍♂️ [SNOOP CREATE] Creando Snoop para fase LISTEN", {
                                        snoopId: "pending",
                                        parentChannelId: channel.id,
                                        linkedId,
                                        app: SNOOP_APP,
                                        appArgs,
                                        spy: 'in',
                                        whisper: 'none',
                                        reason: "listen_phase_init",
                                        phase: currentPhase
                                    });

                                    // 🎯 PASO 1: Crear Snoop
                                    const newSnoop = await ari.channels.snoopChannel({
                                        channelId: channel.id,
                                        app: SNOOP_APP,
                                        appArgs: appArgs, // ✅ FIX: Pasar appArgs
                                        spy: 'in',        // 🔴 SOLO audio del usuario
                                        whisper: 'none'   // 🔕 nunca hablar al usuario
                                    });

                                    // ✅ LOG 1: Confirmación de creación con ID real
                                    log("info", "🕵️‍♂️ [SNOOP CREATE] Snoop creado exitosamente para LISTEN", {
                                        snoopId: newSnoop.id,
                                        parentChannelId: channel.id,
                                        linkedId,
                                        app: SNOOP_APP,
                                        appArgs,
                                        timestamp: Date.now(),
                                        phase: currentPhase
                                    });

                                    // 🎯 PASO 2: Crear contrato formal INMEDIATAMENTE
                                    await createSnoopContract(linkedId, newSnoop.id, channel.id);

                                    // ✅ PRIMITIVA AUDIO_READY: el recurso NO se puede anclar sin WAITING_AST + confirmación Asterisk
                                    await transitionSnoopState(linkedId, SnoopState.CREATED, SnoopState.WAITING_AST);
                                    await waitForAsteriskReady(ari, newSnoop.id, linkedId);

                                    // 🎯 PASO 3: Crear capture bridge ANTES de anclar (si no existe)
                                    if (!captureBridge) {
                                        captureBridge = ari.Bridge();
                                        await captureBridge.create({ type: 'mixing,dtmf_events' });
                                        log("info", `🌉 [BRIDGE] Bridge de captura creado ${captureBridge.id} para anclar Snoop`);
                                    }

                                    // 🎙️ PASO 3.5: Iniciar grabación continua ANTES de agregar Snoop al bridge
                                    // 🎯 CRÍTICO: Asterisk no permite grabar un canal que ya está en un bridge
                                    // Por eso grabamos ANTES de agregarlo al capture bridge
                                    let recordingStarted = false;
                                    if (USE_SEGMENTED_STT && continuousRecorder && segmentStore && sttQueue) {
                                        try {
                                            const startedAtEpochMs = Date.now();

                                            // Grabar el Snoop ANTES de agregarlo al bridge
                                            const rec = await continuousRecorder.start({
                                                callId: linkedId,
                                                snoopChannelId: newSnoop.id
                                            });

                                            recordingStarted = true;

                                            // Guardar metadata en Redis
                                            await segmentStore.setRecMeta(linkedId, {
                                                callId: linkedId,
                                                snoopChannelId: rec.snoopChannelId,
                                                recordingName: rec.recordingName,
                                                recordingPath: rec.recordingPath,
                                                startedAtEpochMs,
                                                status: "recording"
                                            });

                                            // Inicializar segmenter
                                            segmenter = new Segmenter({
                                                callId: linkedId,
                                                logger: log,
                                                store: segmentStore,
                                                enqueueStt: (seg) => sttQueue.enqueue(seg),
                                                preRollMs: 250,
                                                postRollMs: 350,
                                                silenceStableMs: 550,
                                                maxSegmentMs: 12000
                                            });
                                            segmenter.setStartedAt(startedAtEpochMs);

                                            // Configurar listeners de eventos talking del SNOOP
                                            const talkingStartHandler = (evt) => {
                                                if (evt?.channel?.id === rec.snoopChannelId) {
                                                    segmenter.onTalkingStart();
                                                }
                                            };
                                            const talkingStopHandler = (evt) => {
                                                if (evt?.channel?.id === rec.snoopChannelId) {
                                                    segmenter.onTalkingStop();
                                                }
                                            };

                                            ari.on("ChannelTalkingStarted", talkingStartHandler);
                                            ari.on("ChannelTalkingFinished", talkingStopHandler);

                                            // Guardar handlers para cleanup
                                            segmenter._talkingHandlers = {
                                                start: talkingStartHandler,
                                                end: talkingStopHandler
                                            };

                                            log("info", `✅ [RECORDING] Grabación continua iniciada ANTES de agregar Snoop al bridge`, {
                                                snoopChannelId: rec.snoopChannelId,
                                                recordingPath: rec.recordingPath
                                            });

                                        } catch (recErr) {
                                            log("error", `❌ [RECORDING] Error iniciando grabación continua: ${recErr.message}`, {
                                                error: recErr.message,
                                                stack: recErr.stack
                                            });
                                            // Continuar sin grabación continua (fallback al flujo normal)
                                            USE_SEGMENTED_STT = false;
                                        }
                                    }

                                    // 🎯 PASO 4: ANCLAR SNOOP AL BRIDGE DESPUÉS de iniciar grabación (PRODUCTION_TIMING)
                                    // Verificar si el Snoop está realmente listo antes de intentar anclarlo
                                    try {
                                        const snoopChannel = ari.Channel();
                                        const channelState = await snoopChannel.get({ channelId: newSnoop.id });

                                        if (channelState && channelState.state && channelState.state !== 'Down') {
                                            // Snoop está listo - anclar y transicionar a READY
                                            await captureBridge.addChannel({ channel: newSnoop.id });
                                            log("info", `🔗 [SNOOP] Snoop ${newSnoop.id} anclado al capture bridge ${captureBridge.id}`);

                                            // 🎯 PASO 5: NO transicionar a ANCHORED (ADR-002)
                                            // Ya debe estar en READY por StasisStart. Solo loguear éxito.
                                            log("info", `✅ [SNOOP CONTRACT] Snoop ${newSnoop.id} anclado y en estado READY`);

                                            log("info", `✅ [SNOOP CONTRACT] Snoop ${newSnoop.id} en estado READY - Listo para STT (ExternalMedia se agregará en ensureSTT)`);
                                        } else {
                                            // Snoop aún no está listo - mantener en WAITING_AST
                                            // Se activará cuando llegue StasisStart del Snoop
                                            log("info", `🔄 [SNOOP CONTRACT] Snoop ${newSnoop.id} en WAITING_AST - esperando StasisStart para activación`, { linkedId });
                                        }
                                    } catch (anchorErr) {
                                        // Snoop aún no materializado - mantener en WAITING_AST
                                        // NO destruir el contrato - el Snoop se activará cuando llegue StasisStart
                                        log("info", `🔄 [SNOOP CONTRACT] Snoop ${newSnoop.id} aún no materializado - permanecerá en WAITING_AST hasta StasisStart`, {
                                            linkedId,
                                            error: anchorErr.message
                                        });
                                        // NO lanzar error - continuar con el flujo
                                    }

                                    // 🎯 PASO 7: Actualizar contexto
                                    domainContext.audioChannelId = newSnoop.id;
                                    snoopChannelId = newSnoop.id;

                                    // 🎯 Mantener compatibilidad con código legacy (Redis keys)
                                    await Promise.all([
                                        redis.set(`snoop:active:${linkedId}`, newSnoop.id, { EX: 60 }),
                                        redis.set(`snoop:created:${channel.id}`, newSnoop.id, { EX: 3600 }),
                                        redis.set(`snoop:lifetime:${newSnoop.id}:created`, String(snoopCreateStart), { EX: 3600 })
                                    ]).catch(err => {
                                        log("warn", `⚠️ [SNOOP] Error guardando keys legacy en Redis: ${err.message}`);
                                    });

                                    // 🎙️ PASO 8: Inicializar grabación continua y segmenter (si está habilitado)
                                    // 🎯 CRÍTICO: Grabar el Snoop ANTES de agregarlo al bridge
                                    // Asterisk no permite grabar un canal que ya está en un bridge
                                    if (USE_SEGMENTED_STT && continuousRecorder && segmentStore && sttQueue) {
                                        try {
                                            const startedAtEpochMs = Date.now();

                                            // 🎯 CRÍTICO: Grabar el Snoop ANTES de agregarlo al capture bridge
                                            // El Snoop ya está creado (newSnoop.id) pero aún NO está en el bridge
                                            // Esto evita el error "Cannot record channel while in bridge"
                                            const rec = await continuousRecorder.start({
                                                callId: linkedId,
                                                snoopChannelId: newSnoop.id  // Usar el Snoop ya creado
                                            });

                                            // Guardar metadata en Redis
                                            await segmentStore.setRecMeta(linkedId, {
                                                callId: linkedId,
                                                snoopChannelId: rec.snoopChannelId,
                                                recordingName: rec.recordingName,
                                                recordingPath: rec.recordingPath,
                                                startedAtEpochMs,
                                                status: "recording"
                                            });

                                            // Inicializar segmenter
                                            segmenter = new Segmenter({
                                                callId: linkedId,
                                                logger: log,
                                                store: segmentStore,
                                                enqueueStt: (seg) => sttQueue.enqueue(seg),
                                                preRollMs: 250,
                                                postRollMs: 350,
                                                silenceStableMs: 550,
                                                maxSegmentMs: 12000
                                            });
                                            segmenter.setStartedAt(startedAtEpochMs);

                                            // Configurar listeners de eventos talking del SNOOP
                                            const talkingStartHandler = (evt) => {
                                                if (evt?.channel?.id === rec.snoopChannelId) {
                                                    segmenter.onTalkingStart();
                                                }
                                            };
                                            const talkingStopHandler = (evt) => {
                                                if (evt?.channel?.id === rec.snoopChannelId) {
                                                    segmenter.onTalkingStop();
                                                }
                                            };

                                            ari.on("ChannelTalkingStarted", talkingStartHandler);
                                            ari.on("ChannelTalkingFinished", talkingStopHandler);

                                            // Guardar handlers para cleanup
                                            segmenter._talkingHandlers = {
                                                start: talkingStartHandler,
                                                end: talkingStopHandler
                                            };

                                            log("info", `✅ [SEGMENTER] Segmenter inicializado para ${linkedId}`, {
                                                snoopChannelId: rec.snoopChannelId,
                                                recordingPath: rec.recordingPath
                                            });

                                        } catch (recErr) {
                                            log("error", `❌ [RECORDING] Error inicializando grabación continua: ${recErr.message}`, {
                                                error: recErr.message,
                                                stack: recErr.stack
                                            });
                                            // Continuar sin grabación continua (fallback al flujo normal)
                                            USE_SEGMENTED_STT = false;
                                        }
                                    }

                                    const snoopCreateEnd = Date.now();
                                    const snoopCreateTime = snoopCreateEnd - snoopCreateStart;

                                    log("info", `✅ [ENGINE] Snoop creado, anclado y listo para ${currentPhase}: ${newSnoop.id} (${snoopCreateTime}ms)`);
                                    log("info", `🔒 [SNOOP] Snoop protegido y en estado READY para ${currentPhase}`, {
                                        linkedId,
                                        snoopId: newSnoop.id,
                                        captureBridgeId: captureBridge.id
                                    });
                                } catch (snoopErr) {
                                    log("error", `❌ [ENGINE] Error creando/validando Snoop para ${currentPhase}: ${snoopErr.message}`);
                                    // Continuar e intentar recuperar desde Redis o usar fallback
                                }
                            }
                        }
                    }

                    try {
                        await ensureSTT();
                        // 🎯 CRÍTICO: Solo marcar como inicializado si ensureSTT() realmente inicializó STT con un Snoop válido
                        // ensureSTT() lanzará error si no hay Snoop válido, así que si llegamos aquí, está OK
                        // Pero verificamos una vez más que realmente hay un Snoop válido
                        const finalContract = await getSnoopContract(linkedId);
                        const finalAudioSource = domainContext.audioChannelId;
                        if (!finalAudioSource || finalAudioSource === channel.id) {
                            log("error", `❌ [STT INIT] STT no inicializado: No hay Snoop válido después de ensureSTT()`);
                            throw new Error(`STT_INIT_FAILED: No hay Snoop válido después de ensureSTT()`);
                        }

                        // ✅ REGLA 3: STT init atómico - setear snoopChannelId ANTES de marcar como inicializado
                        if (!finalContract || !finalContract.snoopId || finalContract.snoopId !== finalAudioSource) {
                            log("error", `❌ [STT INIT] STT no inicializado: Contrato inválido o snoopId no coincide`, {
                                linkedId,
                                finalAudioSource,
                                contractSnoopId: finalContract?.snoopId,
                                contractState: finalContract?.state
                            });
                            throw new Error(`STT_INIT_FAILED: Contrato inválido o snoopId no coincide`);
                        }

                        // ✅ REGLA 3: STT init atómico - marcar TODO junto
                        snoopChannelId = finalAudioSource; // 🎯 PRIMERO setear snoopChannelId
                        sttPhaseInitialized = currentPhase;
                        sttInitialized = true; // 🎯 SOLO AQUÍ - después de todas las validaciones
                        log("info", `✅ [STT INIT] STT inicializado exitosamente para ${currentPhase} con Snoop ${finalAudioSource}`);
                    } catch (e) {
                        // 🛡️ Manejo específico para canales que no existen (hangup temprano) o Snoop no disponible
                        if (e.message && (
                            e.message.includes('Channel not found') ||
                            e.message.includes('not available') ||
                            e.message.includes('hangup detected') ||
                            e.message.includes('STT abortado') ||
                            e.message.includes('Snoop')
                        )) {
                            log("error", `❌ [STT INIT] STT no inicializado para ${currentPhase}: ${e.message}`);
                            sttInitialized = false;
                            sttPhaseInitialized = null;
                            // ❌ NO seguir escuchando sin STT - abortar turn
                            engineState.silentCount++;
                            continue;
                        }
                        log("error", `❌ Failed to lazy load STT. Skipping turn.`);
                        sttInitialized = false;
                        sttPhaseInitialized = null;
                        engineState.silentCount++;
                        continue;
                    }
                } else if (sttInitialized && sttPhaseInitialized === currentPhase) {
                    // ✅ STT ya está inicializado para esta fase, continuar normalmente
                    log("debug", `🔒 [STT] STT ya inicializado para ${currentPhase}, continuando`);
                }
            } else {
                // 🎯 Para fases no-LISTEN, usar lazy load normal
                try {
                    await ensureSTT();
                } catch (e) {
                    // 🛡️ Manejo específico para canales que no existen (hangup temprano)
                    if (e.message && (e.message.includes('Channel not found') || e.message.includes('not available') || e.message.includes('hangup detected'))) {
                        log("warn", `⚠️ Failed to lazy load STT: Canal no encontrado (hangup temprano), omitiendo turn`);
                        // No incrementar silentCount para evitar loops
                        return; // Salir del turn gracefully
                    }
                    log("error", `❌ Failed to lazy load STT. Skipping turn.`);
                    engineState.silentCount++;
                    continue;
                }
            }

            // 🎯 SOLUCIÓN 3: VAD debe escuchar el Snoop, no el canal base
            // 🚨 REGLA DE ORO: Solo llegar aquí si STT está realmente inicializado
            // Si STT falló, ya se hizo continue arriba, así que no deberíamos llegar aquí
            if (!sttInitialized) {
                log("error", `❌ [STT CONTRACT] Violación: Llegamos a escuchar sin STT inicializado (phase=${currentPhase})`);
                engineState.silentCount++;
                continue; // ❌ NO seguir sin STT
            }

            // ✅ REGLA 3: STT init atómico - si sttInitialized=true, snoopChannelId DEBE existir
            // Si no existe, es un bug crítico - abortar inmediatamente
            let sttChannelId = snoopChannelId; // 🎯 Prioridad 1: Snoop guardado durante inicialización

            if (!sttChannelId) {
                // Intentar recuperar desde Redis como último recurso
                sttChannelId = await redis.get(`snoop:active:${linkedId}`) || await redis.get(`snoop:created:${channel.id}`);

                if (!sttChannelId || sttChannelId === channel.id) {
                    // ✅ REGLA 3: Violación de contrato - STT marcado como inicializado sin audioSource válido
                    log("error", `❌ [STT CONTRACT] Violación crítica: STT inicializado pero no hay Snoop válido (sttChannelId=${sttChannelId})`, {
                        linkedId,
                        currentPhase,
                        sttInitialized,
                        snoopChannelId,
                        domainContextAudioChannelId: domainContext.audioChannelId
                    });
                    log("error", `❌ [STT CONTRACT] audioSource=NONE | phase=${currentPhase} | Snoop requerido pero no disponible`);

                    // ✅ REGLA 3: Invalidar STT - esto es un error de contrato, no continuar
                    sttInitialized = false;
                    sttPhaseInitialized = null;
                    snoopChannelId = null;
                    engineState.silentCount++;
                    continue; // ❌ NO seguir sin Snoop válido
                } else {
                    // Recuperado desde Redis - actualizar snoopChannelId
                    snoopChannelId = sttChannelId;
                    log("warn", `⚠️ [STT] Snoop recuperado desde Redis: ${sttChannelId}`, { linkedId });
                }
            }

            // (Channel switch logic omitted for brevity as handled by ExternalMedia tapping correct channel)

            log("info", `🎧 [STT] Escuchando (Streaming) en canal ${sttChannelId} (Snoop RX)`);
            log("info", `✅ [STT CONTRACT] audioSource=${sttChannelId} | phase=${currentPhase} | Snoop RX válido`);
            log('info', '👂 [USER_LISTENING]', { channel: sttChannelId, isSnoop: true }); // ✅ OBSERVABILITY LOG

            // 🎯 VAD MULTI-FUENTE: Usar caller channel como fuente principal (donde Asterisk detecta talking)
            // Fallback a Snoop si caller no está disponible
            // Estrategia: Asterisk detecta talking en caller, no necesariamente en Snoop
            let voiceDetectionChannel = channel; // Caller channel (fuente principal)
            let hasVoiceEvidence = false; // Flag para tracking multi-fuente

            // Activar TALK_DETECT en caller channel (donde Asterisk SÍ detecta talking)
            try {
                await ari.channels.setChannelVar({
                    channelId: channel.id,
                    variable: 'TALK_DETECT(set)',
                    value: 'on'
                });
                log("info", `🎤 [VAD] TALK_DETECT activado en caller channel ${channel.id} (fuente principal)`);
            } catch (err) {
                log("warn", `⚠️ [VAD] No se pudo activar TALK_DETECT en caller: ${err.message}`);
            }

            // También activar en Snoop como fallback (si está disponible)
            if (sttChannelId && sttChannelId !== channel.id) {
                try {
                    const snoopChannelObj = await ari.channels.get({ channelId: sttChannelId });
                    if (snoopChannelObj && snoopChannelObj.state === 'Up') {
                        try {
                            await ari.channels.setChannelVar({
                                channelId: sttChannelId,
                                variable: 'TALK_DETECT(set)',
                                value: 'on'
                            });
                            log("info", `🎤 [VAD] TALK_DETECT también activado en Snoop ${sttChannelId} (fallback)`);
                        } catch (err) {
                            log("debug", `[VAD] TALK_DETECT en Snoop (opcional): ${err.message}`);
                        }
                    }
                } catch (err) {
                    log("debug", `[VAD] Snoop no disponible para TALK_DETECT: ${err.message}`);
                }
            }

            // 🎯 FALLBACK: Si llegan deltas/completed, eso cuenta como "voz detectada"
            // Esto evita depender 100% de eventos TALK_DETECT que pueden no llegar
            const deltaEvidenceKey = `voicebot:quintero:${linkedId}:rut:hasVoiceEvidence`;
            const checkDeltaEvidence = async () => {
                const evidence = await redis.get(deltaEvidenceKey);
                if (evidence === 'true') {
                    hasVoiceEvidence = true;
                    log("info", `🎤 [VAD] Evidencia de voz por deltas/completed detectada`);
                }
            };

            // Verificar evidencia de deltas antes de esperar VAD
            await checkDeltaEvidence();

            // 🎯 INCREMENTAL RUT: Activar commits periódicos ANTES de esperar voz
            // Esto es crítico porque los eventos delta solo se emiten después de commit
            // Si esperamos a que VAD detecte voz, podemos perder deltas tempranos
            let incrementalRutDetected = false;
            let periodicCommitInterval = null;
            const listenStartTs = Date.now(); // 🎯 FALLA A FIX: Timestamp de inicio para validar buffer mínimo
            let lastCommitTs = 0;
            let audioFramesReceived = 0;

            // 🧊 Guardar referencia para poder detener desde callbacks
            periodicCommitIntervalRef = { current: null };

            // 🎯 CONTRATO: Solo commits periódicos si incremental está activo (controlado por dominio)
            // 🧊 NO activar si la captura ya está congelada
            if (openaiClient.isIncrementalEnabled && openaiClient.isIncrementalEnabled() && sttMode === 'realtime' && !rutCaptureFrozen) {
                log("info", "🔄 [INCREMENTAL RUT] Activando commits periódicos cada 2s para obtener deltas (antes de VAD)");

                // 🛡️ FALLA A FIX: NO hacer warm-up inmediato - esperar buffer mínimo
                // Regla: mínimo 200ms y al menos 10 frames (20ms cada uno ≈ 200ms)
                // El warm-up inmediato causa "buffer too small" error

                // Hacer commit cada 2 segundos mientras escuchamos para obtener deltas
                // Esto permite capturar deltas incluso si VAD no detecta voz correctamente
                periodicCommitInterval = setInterval(() => {
                    // 🧊 FIX: No hacer commit si la captura está congelada
                    if (rutCaptureFrozen) {
                        log("debug", `🧊 [INCREMENTAL RUT] Commit periódico ignorado: captura congelada`);
                        return;
                    }

                    if (sttMode === 'realtime' && openaiClient.isConnected) {
                        const now = Date.now();
                        const elapsed = now - listenStartTs;
                        const timeSinceLastCommit = now - lastCommitTs;

                        // 🎯 FALLA A FIX: Validar buffer mínimo antes de commit
                        // Mínimo 200ms desde inicio Y al menos 500ms desde último commit
                        if (elapsed >= 200 && timeSinceLastCommit >= 500) {
                            log("info", `🔄 [INCREMENTAL RUT] Ejecutando commit periódico para deltas (elapsed=${elapsed}ms)`);
                            openaiClient.commit();
                            lastCommitTs = now;
                        } else {
                            log("debug", `⏸️ [INCREMENTAL RUT] Commit diferido: elapsed=${elapsed}ms, timeSinceLastCommit=${timeSinceLastCommit}ms`);
                        }
                    }
                }, 2000);

                // Guardar referencia
                periodicCommitIntervalRef.current = periodicCommitInterval;
            }

            // 1. Wait for START of speech (Using TALK_DETECT on caller channel + fallback a deltas)
            const listenTimeout = domainContext.lastResult?.config?.listenTimeout || config.audio.maxWaitMs || 4000;

            // 🎯 VAD MULTI-FUENTE: Escuchar AMBOS canales (caller + snoop) y deltas
            // Crear una versión mejorada de waitForRealVoice que acepta múltiples fuentes
            let voiceDetected = { detected: false };

            // 🎯 VAD HÍBRIDO MEJORADO: Verificar deltas periódicamente DURANTE waitForRealVoice
            // Esto reduce latencia al detectar voz por deltas sin esperar timeout completo
            if (hasVoiceEvidence) {
                log("info", `🎤 [VAD] Voz detectada por evidencia de deltas/completed (skip waitForRealVoice)`);
                voiceDetected = { detected: true };
            } else {
                // Esperar eventos de talking en caller channel (donde Asterisk detecta)
                // 🎯 MEJORA: Pasar callback para verificar deltas durante la espera
                voiceDetected = await waitForRealVoice(voiceDetectionChannel, {
                    maxWaitMs: listenTimeout,
                    minTalkingEvents: 1,
                    postPlaybackGuardMs: POST_PLAYBACK_GUARD_MS,
                    lastPlaybackEnd: openaiClient.lastPlaybackEnd,
                    checkDeltaEvidence: async () => {
                        // Verificar evidencia de deltas y actualizar hasVoiceEvidence
                        await checkDeltaEvidence();
                        return hasVoiceEvidence;
                    }
                });

                // Si waitForRealVoice no detectó, verificar evidencia de deltas nuevamente (fallback)
                if (!voiceDetected.detected) {
                    await checkDeltaEvidence();
                    if (hasVoiceEvidence) {
                        log("info", `🎤 [VAD] Voz detectada por deltas después de waitForRealVoice`);
                        voiceDetected = { detected: true };
                    }
                }
            }

            if (!voiceDetected.detected) {
                // 🎯 FIX TIMEOUT: Si waitForRealVoice retorna false prematuramente (ej: canal glitch, error VAD)
                // FORZAR espera hasta cumplir el listenTimeout completo.
                // El log forense mostró timeouts a 1.2s cuando el config era 4.5s.
                const elapsedSinceListen = Date.now() - listenStartTs;
                const remainingTime = listenTimeout - elapsedSinceListen;

                if (remainingTime > 200) { // Si falta más de 200ms
                    log("warn", `⚠️ [TIMEOUT GUARD] VAD retornó false prematuramente (${elapsedSinceListen}ms vs ${listenTimeout}ms) - Forzando espera de ${remainingTime}ms...`);
                    await new Promise(r => setTimeout(r, remainingTime));
                    log("info", `⏰ [TIMEOUT GUARD] Espera forzada completada.`);

                    // Oportunidad final: verificar deltas tras la espera forzada
                    await checkDeltaEvidence();
                    if (hasVoiceEvidence) {
                        log("info", `🎤 [TIMEOUT GUARD] Voz detectada por deltas durante espera forzada`);
                        voiceDetected = { detected: true };
                        // NO entrar al bloque de silencio abajo, continuar procesando
                    }
                }
            }

            if (!voiceDetected.detected) {
                // 🕒 AUDITORÍA: Inicio de detección de silencio
                const tSilenceStart = Date.now();

                // 🎯 INCREMENTAL RUT: Antes de disparar NO_INPUT, consultar Redis
                // Esto permite usar el buffer parcial incluso si VAD no detectó voz
                // CRÍTICO: Los commits periódicos ya ejecutaron y guardaron deltas en Redis
                let hasPartialTranscript = false;
                if (openaiClient.isIncrementalEnabled && openaiClient.isIncrementalEnabled() && sttMode === 'realtime') {
                    log("info", `🔍 [INCREMENTAL RUT] VAD no detectó voz, consultando Redis para buffer parcial (linkedId=${linkedId})`);

                    // 🕒 AUDITORÍA: Tiempo de lectura de Redis
                    const tRedisStart = Date.now();
                    const partialRut = await getPartialRut(linkedId);
                    const tRedisEnd = Date.now();
                    const redisReadTime = tRedisEnd - tRedisStart;

                    if (partialRut && partialRut.trim().length > 0) {
                        log("info", `✅ [INCREMENTAL RUT] Buffer parcial encontrado en Redis: "${partialRut}" → usando como transcript`, {
                            redisReadTime: `${redisReadTime}ms`
                        });
                        // Limpiar commits periódicos
                        if (periodicCommitInterval) {
                            clearInterval(periodicCommitInterval);
                        }
                        if (periodicCommitIntervalRef?.current) {
                            clearInterval(periodicCommitIntervalRef.current);
                            periodicCommitIntervalRef.current = null;
                        }

                        // 🎯 ARQUITECTURA CORRECTA: El ENGINE llama al webhook cuando detecta silencio + buffer
                        // Obtener texto consolidado SIN espacios
                        // 🕒 AUDITORÍA: Tiempo de consolidación
                        const tConsolidateStart = Date.now();
                        const consolidatedText = await getConsolidatedRutText(linkedId);
                        const tConsolidateEnd = Date.now();
                        const consolidateTime = tConsolidateEnd - tConsolidateStart;

                        // 🎯 USAR FUNCIÓN REUTILIZABLE: Invocar webhook usando función centralizada
                        // Esto evita duplicación de código y permite triggers desde múltiples puntos
                        // 🎯 REPRODUCIR AUDIO DE FONDO durante la espera del webhook
                        const webhookInvoked = await invokeRutWebhook(linkedId, 'silence-detected', { playBackgroundAudio: true });

                        if (webhookInvoked) {
                            // 🕒 AUDITORÍA: Tiempo total desde silencio hasta resultado
                            const tTotal = Date.now() - tSilenceStart;
                            log("info", `⏱️ [ENGINE][TIMING] VAD_SILENCE → RUT_CAPTURE_RESULT`, {
                                callId: linkedId,
                                redisRead: `${redisReadTime}ms`,
                                consolidate: `${consolidateTime}ms`,
                                total: `${tTotal}ms`,
                                triggerReason: 'silence-detected'
                            });

                            // Limpiar buffer después de llamar al webhook
                            await clearPartialRut(linkedId);
                        }

                        // Usar el buffer parcial como transcript (para compatibilidad con flujo existente)
                        transcript = partialRut;
                        // Resetear contador de silencio
                        engineState.silentCount = 0;
                        hasPartialTranscript = true;
                        // Salir del bloque de escucha - el transcript se procesará después
                        // No hacer break del while, solo salir del bloque if
                    } else {
                        log("warn", `⚠️ [INCREMENTAL RUT] VAD no detectó voz y Redis no tiene buffer parcial`);
                    }
                }

                // Si no hay transcript parcial, proceder con NO_INPUT
                if (!hasPartialTranscript) {
                    // Limpiar commits periódicos si no se detectó voz y no hay buffer parcial
                    if (periodicCommitInterval) {
                        clearInterval(periodicCommitInterval);
                        log("debug", "🔄 [INCREMENTAL RUT] Limpiando commits periódicos (no se detectó voz)");
                    }
                    if (periodicCommitIntervalRef?.current) {
                        clearInterval(periodicCommitIntervalRef.current);
                        periodicCommitIntervalRef.current = null;
                    }

                    engineState.silentCount++;
                    if (engineState.silentCount >= MAX_SILENT_TURNS) {
                        log("warn", "🛑 Max silence reached");

                        // 🎯 AUDIO MARKS: Marcar timeout por max silence
                        await emitAudioMark(audioCtx, {
                            type: AudioMarkType.TIMEOUT,
                            reason: "max_silence_turns_reached"
                        }, log, redis);

                        break;
                    }

                    // 🎯 AUDIO MARKS: Marcar timeout cuando no hay input
                    await emitAudioMark(audioCtx, {
                        type: AudioMarkType.TIMEOUT,
                        reason: "no_input_detected"
                    }, log, redis);

                    await delegateDomainEvent('NO_INPUT', domainContext, openaiClient, conversationState, ari, channel, ani, dnis, linkedId, captureBridge, voiceBridgeRef);

                    // 🛠️ FIX 2: PHASE PERSISTENCE (Post-NO_INPUT)
                    if (domainContext.lastResult?.nextPhase) {
                        domainContext.state = domainContext.state || {};
                        domainContext.state.rutPhase = domainContext.lastResult.nextPhase;
                        // 🎯 SOLUCIÓN 1: Guardar fase en Redis para protección del Snoop durante cleanup
                        if (domainContext.lastResult.nextPhase) {
                            // 🛡️ ENFORCEMENT: Validar fase propuesta por dominio
                            const { isValidPhase } = await import('./lifecycle-contract.js');
                            const proposedPhase = domainContext.lastResult.nextPhase;

                            if (!isValidPhase(proposedPhase)) {
                                log("warn", `⚠️ [LIFECYCLE] Fase propuesta no válida: ${proposedPhase} - Manteniendo fase actual`);
                            } else {
                                await redis.set(`phase:${linkedId}`, proposedPhase, { EX: 3600 });
                                log("info", `🔒 [LIFECYCLE] Fase confirmada por engine: ${proposedPhase} (linkedId=${linkedId})`, {
                                    previousPhase: domainContext.state?.rutPhase || 'unknown',
                                    newPhase: proposedPhase,
                                    validated: true
                                });

                                // 🎯 AUDIO MARKS: Emitir LISTEN_START cuando entra a LISTEN_RUT
                                if (proposedPhase === 'LISTEN_RUT') {
                                    // 🧊 Reset freeze cuando se entra a LISTEN_RUT (nuevo intento)
                                    rutCaptureFrozen = false;
                                    rutFirstCompletedAt = 0;
                                    await redis.del(`voicebot:quintero:${linkedId}:rut:captureFrozen`);
                                    await redis.del(`voicebot:quintero:${linkedId}:stt:closed`); // Permitir nueva sesión STT limpia
                                    // 🎯 CRÍTICO: Resetear flags de STT para permitir reinicialización
                                    sttInitAttempted = false;
                                    sttLastInitAttemptAt = 0;
                                    log("info", `🧊 [ENGINE] Reset freeze de captura RUT (nuevo intento LISTEN_RUT) - Nueva sesión STT permitida`);

                                    await emitAudioMark(audioCtx, {
                                        type: AudioMarkType.LISTEN_START,
                                        reason: "domain_transition:LISTEN_RUT"
                                    }, log, redis);
                                } else if (proposedPhase !== 'LISTEN_RUT' && rutCaptureFrozen) {
                                    // 🧊 Reset freeze cuando se sale de LISTEN_RUT
                                    rutCaptureFrozen = false;
                                    rutFirstCompletedAt = 0;
                                    await redis.del(`voicebot:quintero:${linkedId}:rut:captureFrozen`);
                                    log("info", `🧊 [ENGINE] Reset freeze de captura RUT (salida de LISTEN_RUT → ${proposedPhase})`);
                                }
                            }
                        }
                    }

                    if (domainContext.lastResult?.silent) {
                        engineState.skipInput = true;
                    }
                    continue;
                }
                // Si hay transcript parcial, saltar el bloque de espera de silencio y procesar directamente
                // El transcript ya está asignado, así que saltamos todo el bloque de espera de silencio
            } else {
                // VAD detectó voz - proceder con el flujo normal de espera de silencio
                engineState.silentCount = 0;
                log("info", "🗣️ Voz detectada. Esperando fin de frase...");

                // 🎯 INCREMENTAL RUT: Consultar Redis cada 500ms mientras esperamos
                // 🎯 MEJORA: Usar getRutState para detectar RUT válido temprano (no solo isValidPartialRut)
                // Esto permite detectar RUT VALIDADO con alta confianza antes de que termine el silencio
                if (openaiClient.isIncrementalEnabled && openaiClient.isIncrementalEnabled() && sttMode === 'realtime') {
                    const { getRutState } = await import('./incremental-rut-processor.js');
                    const { IdentityState } = await import('./identity-capture.js');

                    let lastPartialText = '';
                    let lastPartialChangeTs = Date.now();
                    const STABILITY_WINDOW_MS = 600; // 🎯 ENDPOINTING: 600ms sin cambios = estabilidad
                    const MIN_STABLE_DELTAS = 2; // Al menos 2 deltas sin cambios

                    const checkInterval = setInterval(async () => {
                        // 🎯 DELTA-FIRST: Verificar estado completo de RUT (incluyendo confidence)
                        const rutState = await getRutState(linkedId);

                        // Ruta rápida: Si RUT está VALIDADO con alta confianza, forzar commit
                        if (rutState.state === IdentityState.VALIDADO && rutState.confidence >= 85) {
                            log("info", `🎯 [DELTA-FIRST] RUT VALIDADO detectado temprano: "${rutState.normalized}" (confidence=${rutState.confidence}) → forcing final commit`);
                            incrementalRutDetected = true;
                            clearInterval(checkInterval);
                            if (periodicCommitInterval) clearInterval(periodicCommitInterval);
                            if (periodicCommitIntervalRef?.current) {
                                clearInterval(periodicCommitIntervalRef.current);
                                periodicCommitIntervalRef.current = null;
                            }
                            // Forzar commit final del audio para obtener transcript completo
                            openaiClient.commit();
                            return;
                        }

                        // 🎯 ENDPOINTING POR ESTABILIDAD: Detectar cuando partials no cambian
                        const currentPartial = rutState.partial || '';
                        if (currentPartial === lastPartialText && currentPartial.length > 0) {
                            const timeSinceChange = Date.now() - lastPartialChangeTs;
                            if (timeSinceChange >= STABILITY_WINDOW_MS) {
                                log("info", `🎯 [ENDPOINTING] Estabilidad detectada: "${currentPartial}" sin cambios por ${timeSinceChange}ms → forzando commit`);
                                incrementalRutDetected = true;
                                clearInterval(checkInterval);
                                if (periodicCommitInterval) clearInterval(periodicCommitInterval);
                                if (periodicCommitIntervalRef?.current) {
                                    clearInterval(periodicCommitIntervalRef.current);
                                    periodicCommitIntervalRef.current = null;
                                }
                                openaiClient.commit();
                                return;
                            }
                        } else if (currentPartial !== lastPartialText) {
                            // Partial cambió, resetear timestamp
                            lastPartialText = currentPartial;
                            lastPartialChangeTs = Date.now();
                        }

                        // Fallback: Si isValidPartialRut (compatibilidad)
                        const partialRut = await getPartialRut(linkedId);
                        if (isValidPartialRut(partialRut)) {
                            log("info", `🎯 [INCREMENTAL RUT] Valid RUT detected (fallback): "${partialRut}" → forcing final commit`);
                            incrementalRutDetected = true;
                            clearInterval(checkInterval);
                            if (periodicCommitInterval) clearInterval(periodicCommitInterval);
                            if (periodicCommitIntervalRef?.current) {
                                clearInterval(periodicCommitIntervalRef.current);
                                periodicCommitIntervalRef.current = null;
                            }
                            openaiClient.commit();
                        }
                    }, 500);

                    // Limpiar intervalos después de 10 segundos máximo
                    setTimeout(() => {
                        clearInterval(checkInterval);
                        if (periodicCommitInterval) clearInterval(periodicCommitInterval);
                        if (periodicCommitIntervalRef?.current) {
                            clearInterval(periodicCommitIntervalRef.current);
                            periodicCommitIntervalRef.current = null;
                        }
                    }, 10000);
                }

                // 2. Wait for END of speech (Silence) - pero solo si no detectamos RUT incremental
                if (!incrementalRutDetected) {
                    await new Promise(resolve => {
                        let finished = false;
                        let webhookTimer = null; // 🎯 MEJORA: Timer activo para webhook

                        const onSilence = () => {
                            if (finished) return;
                            finished = true;
                            if (webhookTimer) clearTimeout(webhookTimer);
                            log("debug", "🤫 Silence detected (event)");
                            resolve();
                        };

                        const onEvent = async (event, c) => {
                            if (c.id === channel.id) {
                                channel.removeListener('ChannelTalkingFinished', onEvent);

                                // 🎯 SOLUCIÓN 1: Timer activo después de ChannelTalkingFinished
                                // Calcular tiempo restante de silencio necesario
                                const callKey = linkedId;
                                const lastSpeechTsKey = `voicebot:quintero:${callKey}:rut:lastSpeechTs`;
                                const lastSpeechTs = await redis.get(lastSpeechTsKey);
                                const now = Date.now();
                                const elapsed = lastSpeechTs ? (now - parseInt(lastSpeechTs, 10)) : 0;
                                const remaining = MIN_SILENCE_MS - elapsed;

                                if (remaining > 0) {
                                    log("debug", `⏰ [ENGINE] ChannelTalkingFinished recibido, esperando ${remaining}ms restantes para MIN_SILENCE_MS`);
                                    // ⏰ Esperar el tiempo restante antes de resolver
                                    webhookTimer = setTimeout(() => {
                                        if (!finished) {
                                            log("debug", "⏰ [ENGINE] Timer de silencio completado");
                                            onSilence();
                                        }
                                    }, remaining);
                                } else {
                                    // ✅ Ya pasó suficiente tiempo, resolver inmediatamente
                                    log("debug", `✅ [ENGINE] Silencio suficiente (${elapsed}ms >= ${MIN_SILENCE_MS}ms), resolviendo inmediatamente`);
                                    onSilence();
                                }
                            }
                        };
                        channel.on('ChannelTalkingFinished', onEvent);

                        // 🎙️ SEGMENTER: Registrar commit cuando VAD detecta silencio
                        if (USE_SEGMENTED_STT && segmenter) {
                            segmenter.onCommit('vad_silence');
                        }

                        // Timeout de seguridad (max utterance 5s) - wait for sufficient silence
                        const silenceTimer = setTimeout(async () => {
                            if (!finished) {
                                log("debug", "⏱️ Max utterance reached");
                                channel.removeListener('ChannelTalkingFinished', onEvent);
                                if (webhookTimer) clearTimeout(webhookTimer);

                                // 🎯 AUDIO MARKS: Marcar timeout de utterance
                                await emitAudioMark(audioCtx, {
                                    type: AudioMarkType.TIMEOUT,
                                    reason: "max_utterance_reached"
                                }, log, redis);

                                onSilence();
                            }
                        }, 5000);

                        // Wait for MIN_SILENCE_MS
                        // Logic handled by VAD event mostly, but we ensure we don't trigger on micro-pauses
                    });
                } else {
                    // Si detectamos RUT incremental, limpiar intervalos y esperar procesamiento
                    if (periodicCommitInterval) clearInterval(periodicCommitInterval);
                    if (periodicCommitIntervalRef?.current) {
                        clearInterval(periodicCommitIntervalRef.current);
                        periodicCommitIntervalRef.current = null;
                    }
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                // 3. COMMIT REALTIME (Best effort) - solo si no se hizo commit incremental
                // Si ya hicimos commits periódicos, no necesitamos commit final aquí
                if (!incrementalRutDetected && !periodicCommitIntervalRef?.current && sttMode === 'realtime') {
                    openaiClient.commit();
                } else if (periodicCommitIntervalRef?.current) {
                    // Limpiar intervalo periódico si aún está activo
                    clearInterval(periodicCommitIntervalRef.current);
                    periodicCommitIntervalRef.current = null;
                }
            }

            // 4. PREPARE FALLBACK PATH (Continuous Recording or Legacy Buffer)
            let fallbackPath = null;

            if (sttMode === 'legacy-batch') {
                // 📼 COMPILE LEGACY BUFFER TO WAV
                if (legacyAudioBuffer.length > 0) {
                    try {
                        const wavBuffer = encodeWav(legacyAudioBuffer);
                        const recId = `legacy_${linkedId}_${Date.now()}`;
                        fallbackPath = `/tmp/${recId}.wav`;
                        fs.writeFileSync(fallbackPath, wavBuffer);
                        log("info", `📼 [LEGACY] Audio buffer saved (${legacyAudioBuffer.length} chunks) -> ${fallbackPath}`);

                        // Clear buffer for next turn
                        legacyAudioBuffer.length = 0;

                        // 📝 TRANSCRIBE IMMEDIATELY
                        transcript = await openaiClient.transcribeAudioWithWhisper(fallbackPath);
                        log("info", `📝 [LEGACY STT] Transcript: "${transcript}"`);

                    } catch (err) {
                        log("error", `❌ [LEGACY] Error saving/transcribing buffer: ${err.message}`);
                    }
                } else {
                    log("warn", "⚠️ [LEGACY] Audio buffer empty on silence detection");
                }

            } else {
                // ... Existing Realtime Fallback Logic ...
                // Retrieve the active recording handle from Redis for the STT (Snoop) provider channel
                try {
                    const recHandle = await redis.get(`recording:${sttChannelId}`);
                    if (recHandle) {
                        const date = new Date();
                        const year = date.getFullYear();
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const day = String(date.getDate()).padStart(2, '0');
                        // Construct path matching telephony-recorder structure
                        fallbackPath = `/opt/telephony-core/recordings/default/${year}/${month}/${day}/${recHandle}.wav`;
                        log("debug", `📂 [ENGINE] Found continuous recording path: ${fallbackPath}`);
                    }
                } catch (err) {
                    log("warn", `⚠️ [ENGINE] Failed to resolve fallback recording path: ${err.message}`);
                }

                // 5. GET TRANSCRIPT (Realtime -> Fallback)
                transcript = await openaiClient.waitForTranscript(3000); // 3s wait for Realtime

                // 🎯 INCREMENTAL RUT: Si no hay transcript del evento completed, consultar Redis como fallback
                // ⚠️ IMPORTANTE: Este bloque NO debe llamar al webhook
                // El webhook solo se llama cuando VAD detecta silencio (bloque anterior, líneas 440-579)
                // Este bloque solo usa el buffer como transcript para el dominio
                if (!transcript && openaiClient.isIncrementalEnabled && openaiClient.isIncrementalEnabled()) {
                    log("debug", `🔍 [INCREMENTAL RUT] waitForTranscript no devolvió transcript, consultando Redis como fallback (linkedId=${linkedId})`);
                    const partialRut = await getPartialRut(linkedId);
                    if (partialRut && partialRut.trim().length > 0) {
                        // Usar el buffer parcial acumulado como transcript (puede ser RUT parcial o texto completo)
                        // No validamos aquí si es RUT válido - el dominio lo hará
                        // ⚠️ NO llamar webhook aquí - el webhook se llama solo cuando VAD detecta silencio
                        transcript = partialRut;
                        log("info", `✅ [INCREMENTAL RUT] Buffer parcial encontrado en Redis (fallback), usando como transcript: "${transcript}"`);
                    } else {
                        log("warn", `⚠️ [INCREMENTAL RUT] Buffer parcial vacío en Redis (linkedId=${linkedId})`);
                    }
                } else if (transcript) {
                    log("info", `✅ [STT] Transcript obtenido de evento completed: "${transcript}"`);
                } else {
                    log("warn", `⚠️ [STT] No hay transcript ni buffer parcial disponible`);
                }

                if (!transcript && fallbackPath && fs.existsSync(fallbackPath)) {
                    log("warn", "⚠️ [ENGINE] Realtime empty. Executing Whisper Fallback...");
                    const whisperText = await openaiClient.transcribeAudioWithWhisper(fallbackPath);
                    if (whisperText) {
                        transcript = whisperText;
                        log("info", `📝 [WHISPER] Recovered text: "${transcript}"`);
                    }
                }
            }

            log("info", `📝 [STT FINAL] Transcript: "${transcript || '(vacío)'}"`);
            log('info', '✍️ [USER_SPOKE]', { transcript, confidence: 1.0 }); // ✅ OBSERVABILITY LOG

            if (fallbackPath && sttMode === 'legacy-batch') {
                // Cleanup temp legacy file
                try { fs.unlinkSync(fallbackPath); } catch (e) { }
            }

            if (!transcript) {
                log("warn", "⚠️ [STT] No transcription received");
                engineState.silentCount++;

                // 🎯 AUDIO MARKS: Marcar timeout cuando no hay transcript
                await emitAudioMark(audioCtx, {
                    type: AudioMarkType.TIMEOUT,
                    reason: "no_transcript_received"
                }, log, redis);

                await delegateDomainEvent('NO_INPUT', domainContext, openaiClient, conversationState, ari, channel, ani, dnis, linkedId, captureBridge, voiceBridgeRef);
                continue;
            }
        }

        // 3️⃣ REGULAR TURN
        log("info", `📤 [ENGINE] Enviando transcript al dominio: "${transcript}" (event=TURN)`);
        const ctx = buildDomainCtx(transcript, domainContext, ari, channel, ani, dnis, linkedId);
        const domainResult = await domainContext.domain({
            ...ctx,
            event: 'TURN'
        });
        log("info", `📥 [ENGINE] Respuesta del dominio recibida: nextPhase=${domainResult?.nextPhase}, action=${domainResult?.action?.type || domainResult?.action}`);

        // 🎙️ SEGMENTER HOOKS: Abrir/cerrar ventanas según fase (si está habilitado)
        if (USE_SEGMENTED_STT && segmenter) {
            const currentPhase = domainContext.state?.rutPhase || await redis.get(`phase:${linkedId}`);
            const nextPhase = domainResult?.nextPhase || domainResult?.phase;

            // Fases que requieren ventana abierta (escucha)
            const listenPhases = ['LISTEN_RUT', 'ASK_DATE', 'ASK_SPECIALTY', 'WAIT_RUT', 'LISTEN_OPTION', 'LISTEN_CONFIRMATION'];
            const isListenPhase = nextPhase && listenPhases.includes(nextPhase);
            const wasListenPhase = currentPhase && listenPhases.includes(currentPhase);

            // Si cambiamos a una fase de escucha, abrir ventana
            if (isListenPhase && !wasListenPhase) {
                segmenter.openWindow(nextPhase);
                log("info", `🪟 [SEGMENTER] Ventana abierta para fase: ${nextPhase}`);
            }

            // Si salimos de una fase de escucha, cerrar ventana y forzar flush
            if (wasListenPhase && !isListenPhase) {
                segmenter.forceFlush('phase_transition');
                segmenter.closeWindow();
                log("info", `🪟 [SEGMENTER] Ventana cerrada para fase: ${currentPhase} → ${nextPhase}`);
            }

            // Si el dominio indica que aceptó (ej: RUT válido), forzar flush
            if (domainResult?.action?.type === 'SET_STATE' && domainResult?.action?.payload?.updates) {
                // Verificar si hay datos aceptados (ej: rutFormatted, fecha, especialidad)
                const updates = domainResult.action.payload.updates;
                if (updates.rutFormatted || updates.fecha_hora || updates.especialidad) {
                    segmenter.forceFlush('domain_accept');
                    log("info", `✅ [SEGMENTER] Flush forzado por aceptación del dominio`);
                }
            }
        }

        // UPDATE STATE
        if (domainResult) {
            if (domainResult.state) {
                domainContext.state = domainResult.state;
                // 🎯 SOLUCIÓN 1: Guardar fase en Redis para protección del Snoop durante cleanup
                if (domainResult.state.rutPhase) {
                    // 🛡️ ENFORCEMENT: Validar fase propuesta por dominio
                    const { isValidPhase } = await import('./lifecycle-contract.js');
                    const proposedPhase = domainResult.state.rutPhase;

                    if (!isValidPhase(proposedPhase)) {
                        log("warn", `⚠️ [LIFECYCLE] Fase propuesta no válida: ${proposedPhase} - Manteniendo fase actual`);
                    } else {
                        await redis.set(`phase:${linkedId}`, proposedPhase, { EX: 3600 });
                        log("info", `🔒 [LIFECYCLE] Fase confirmada por engine: ${proposedPhase} (linkedId=${linkedId})`, {
                            previousPhase: domainContext.state?.rutPhase || 'unknown',
                            newPhase: proposedPhase,
                            validated: true
                        });

                        // 🎯 AUDIO MARKS: Emitir LISTEN_START cuando entra a LISTEN_RUT
                        if (proposedPhase === 'LISTEN_RUT') {
                            // 🧊 Reset freeze cuando se entra a LISTEN_RUT (nuevo intento)
                            rutCaptureFrozen = false;
                            rutFirstCompletedAt = 0;
                            await redis.del(`voicebot:quintero:${linkedId}:rut:captureFrozen`);
                            await redis.del(`voicebot:quintero:${linkedId}:stt:closed`); // Permitir nueva sesión STT limpia
                            // 🎯 CRÍTICO: Resetear flags de STT para permitir reinicialización
                            sttInitAttempted = false;
                            sttLastInitAttemptAt = 0;
                            log("info", `🧊 [ENGINE] Reset freeze de captura RUT (nuevo intento LISTEN_RUT) - Nueva sesión STT permitida`);

                            await emitAudioMark(audioCtx, {
                                type: AudioMarkType.LISTEN_START,
                                reason: "domain_transition:LISTEN_RUT"
                            }, log, redis);
                        } else if (proposedPhase !== 'LISTEN_RUT' && rutCaptureFrozen) {
                            // 🧊 Reset freeze cuando se sale de LISTEN_RUT
                            rutCaptureFrozen = false;
                            rutFirstCompletedAt = 0;
                            await redis.del(`voicebot:quintero:${linkedId}:rut:captureFrozen`);
                            log("info", `🧊 [ENGINE] Reset freeze de captura RUT (salida de LISTEN_RUT → ${proposedPhase})`);
                        }
                    }
                }
            }
            // ✅ UPDATE SKIP INPUT FLAG
            // IMPORTANT: never couple silent->skipInput. Silent only controls barge-in.
            // skipInput controls whether we open STT/VAD on next turn.
            engineState.skipInput = (domainResult.skipInput === true || domainResult.skipUserInput === true);
            // Store last result for checks
            domainContext.lastResult = domainResult;

            // 🎯 CONTRATO INCREMENTAL: Engine ejecuta flags del dominio (ejecutor ciego)
            if (openaiClient.enableIncremental && openaiClient.disableIncremental) {
                if (domainResult.enableIncremental === true) {
                    log("info", "🎯 [ENGINE] Recibido enableIncremental=true del dominio, ejecutando...");
                    openaiClient.enableIncremental();
                    log("info", "🎯 [ENGINE] Incremental activado por dominio");
                }
                if (domainResult.disableIncremental === true) {
                    log("info", "🎯 [ENGINE] Recibido disableIncremental=true del dominio, ejecutando...");
                    openaiClient.disableIncremental();
                    log("info", "🎯 [ENGINE] Incremental desactivado por dominio");
                }
                // Debug: Verificar estado actual
                if (domainResult.enableIncremental !== undefined || domainResult.disableIncremental !== undefined) {
                    log("debug", `🎯 [ENGINE] Flags incrementales recibidos: enable=${domainResult.enableIncremental}, disable=${domainResult.disableIncremental}, estado actual=${openaiClient.isIncrementalEnabled()}`);
                }
            } else {
                log("warn", "⚠️ [ENGINE] Cliente no soporta incremental (métodos no disponibles)");
            }
        }

        await applyDomainResult(domainResult, openaiClient, conversationState, ari, channel, captureBridge, voiceBridgeRef, domainContext);

        if (domainResult?.shouldHangup || domainResult?.action === 'HANGUP') {
            engineState.active = false;
            break;
        }
    }

    // =======================================================
    // FINALIZE
    // =======================================================
    openaiClient.disconnect();
    log("info", `🔚 Session end ${linkedId}`);

    // 🎯 INVARIANT LOGGING (Architectural verification)
    try {
        const { getSnoopContract } = await import("./contracts/snoop.contract.js");
        const finalSnoop = await getSnoopContract(linkedId);
        log("info", `INVARIANTS: Bridge=${voiceBridgeRef?.current?.id || 'none'} Snoop=${finalSnoop?.snoopId || 'none'} SnoopState=${finalSnoop?.state || 'none'} STT=${sttInitialized} Channel=${channel.id} Role=${conversationState.history.length > 0 ? 'active' : 'empty'}`);
    } catch (e) {
        log("warn", `⚠️ Error logging invariants: ${e.message}`);
    }

    await CallFinalizer.finalize(
        ari,
        channel,
        { ...conversationState, ...activeSessions.get(linkedId) }, // Merge persistent meta
        { silentTurns: engineState.silentCount },
        domainContext.state || {}
    );
}

// =======================================================
// HELPERS
// =======================================================

function buildDomainCtx(transcript, domainContext, ari, channel, ani, dnis, linkedId) {
    return {
        transcript,
        sessionId: linkedId,
        ani,
        dnis,
        state: domainContext.state,
        ari,
        channel
    };
}

async function delegateDomainEvent(eventType, domainContext, openaiClient, conversationState, ari, channel, ani, dnis, linkedId, captureBridge, voiceBridgeRef) {
    const ctx = buildDomainCtx("", domainContext, ari, channel, ani, dnis, linkedId);
    const result = await domainContext.domain({
        ...ctx,
        event: eventType
    });

    if (result) {
        if (result.state) domainContext.state = result.state;
        domainContext.lastResult = result;
    }

    // 🎯 CONTRATO INCREMENTAL: Ejecutar flags del dominio en NO_INPUT también
    if (result && openaiClient.enableIncremental && openaiClient.disableIncremental) {
        if (result.enableIncremental === true) {
            openaiClient.enableIncremental();
            log("info", "🎯 [ENGINE] Incremental activado por dominio (NO_INPUT)");
        }
        if (result.disableIncremental === true) {
            openaiClient.disableIncremental();
            log("info", "🎯 [ENGINE] Incremental desactivado por dominio (NO_INPUT)");
        }
    }

    await applyDomainResult(result, openaiClient, conversationState, ari, channel, captureBridge, voiceBridgeRef, domainContext);
}

async function applyDomainResult(result, openaiClient, conversationState, ari, channel, captureBridge, voiceBridgeRef, domainContext) {
    if (!result) return;

    // 🛡️ VALIDACIÓN CRÍTICA: Verificar que domainContext existe
    if (!domainContext) {
        log("error", `❌ [APPLY_DOMAIN_RESULT] domainContext es requerido pero no fue proporcionado`);
        throw new Error("domainContext is required but was not provided to applyDomainResult");
    }

    // NORMALIZE ACTION
    // Handles { action: 'PLAY_AUDIO', audio: 'path' } vs { action: 'SAY_TEXT', text: '...' }
    // Also supports legacy formats for backward compatibility via 'adapter' logic if strictly needed,
    // but we prefer strict here.

    const action = result.action || 'WAIT_INPUT'; // Default

    // ✅ ARQUITECTURA DESACOPLADA: Normalizar salida del bot (WAV y TTS unificados)
    const botOutput = normalizeBotOutput(result);
    const currentPhase = domainContext.state?.rutPhase || 'START_GREETING';

    if (botOutput) {
        logBotOutput(botOutput, currentPhase);
    }

    // ✅ ARQUITECTURA DESACOPLADA: Obtener política de interrupción del dominio
    // Compatible con formato legacy (silent, allowBargeIn)
    const interruptPolicy = botOutput ? botOutput.interruptPolicy : createInterruptPolicyFromDomainResult(result);
    const silent = result.silent === true; // Mantener para compatibilidad legacy

    // 1. AUDIO PLAYBACK (Implicit or Explicit) - Unificado WAV y TTS
    const audioFile = result.audio || result.soundFile;
    if (action === 'PLAY_AUDIO' || audioFile || requiresTTSGeneration(botOutput)) {
        // ✅ ARQUITECTURA DESACOPLADA: Tratar WAV y TTS igual
        if (botOutput && botOutput.type === 'static') {
            // AUDIO ESTÁTICO (WAV)
            const staticFile = botOutput.payload.file;

            // 🎯 LIFECYCLE GOVERNANCE: Verificar si playback está permitido en esta fase
            // 🎯 CRÍTICO: Usar la fase ACTUAL (no la propuesta en nextPhase)
            // El playback debe ejecutarse en la fase donde estamos, no en la siguiente
            const currentPhase = domainContext.state?.rutPhase || 'START_GREETING';
            const linkedId = channel.linkedid || channel.id;

            log("info", `🔒 [LIFECYCLE] Validando playback en fase ACTUAL: ${currentPhase} (nextPhase propuesta: ${result.nextPhase || 'none'})`);

            // 📊 LOG DETALLADO: Estado antes de validar playback
            log("info", `🔒 [LIFECYCLE] Pre-validación PLAYBACK:`, {
                phase: currentPhase,
                audioFile: staticFile || audioFile,
                outputType: botOutput?.type || 'legacy',
                channelId: channel.id,
                linkedId: linkedId,
                voiceBridgeExists: !!voiceBridgeRef?.current,
                voiceBridgeId: voiceBridgeRef?.current?.id || 'none'
            });

            const playbackFile = staticFile || audioFile;
            const playbackAllowed = await isActionAllowed(currentPhase, 'PLAYBACK', {
                channelId: channel.id,
                linkedId: linkedId,
                callKey: linkedId,
                audioFile: playbackFile,
                voiceBridgeId: voiceBridgeRef?.current?.id
            });

            if (!playbackAllowed) {
                log("warn", `🔒 [LIFECYCLE] ❌ PLAYBACK BLOQUEADO en fase ${currentPhase} - No se reproducirá audio ${playbackFile}`);
                return; // No reproducir si la fase no lo permite
            }

            // 🎯 LIFECYCLE GOVERNANCE: Verificar si bridge es requerido
            const bridgeRequired = isResourceRequired(currentPhase, 'BRIDGE', {
                channelId: channel.id,
                linkedId: linkedId,
                audioFile: playbackFile
            });

            if (bridgeRequired) {
                log("info", `🔒 [LIFECYCLE] ✅ Bridge REQUERIDO en fase ${currentPhase}`);
            }

            // 📊 LOG DETALLADO: Contrato completo de la fase
            const phaseContract = getPhaseContract(currentPhase, true);

            log("info", `🔒 [LIFECYCLE] ✅ PLAYBACK PERMITIDO: phase=${currentPhase}, allowsPLAYBACK=true, requiresBRIDGE=${bridgeRequired}, contract=${JSON.stringify(phaseContract ? { allow: phaseContract.allow, deny: phaseContract.deny, requires: phaseContract.requires } : 'null')}`);

            // 🎤 CRÍTICO: Asegurar que el canal esté en un bridge de voz ANTES de reproducir
            // Sin esto, el audio no se escucha porque no hay ruta de media activa
            if (!voiceBridgeRef.current) {
                // 🎯 LIFECYCLE GOVERNANCE: Verificar si crear bridge está permitido
                const createBridgeAllowed = await isActionAllowed(currentPhase, 'CREATE_BRIDGE', {
                    channelId: channel.id,
                    linkedId: linkedId,
                    audioFile: audioFile,
                    phase: currentPhase
                });

                if (!createBridgeAllowed) {
                    log("warn", `🔒 [LIFECYCLE] ❌ CREATE_BRIDGE BLOQUEADO en fase ${currentPhase} - No se creará bridge`);
                    return; // No crear bridge si la fase no lo permite
                }

                log("info", `🔒 [LIFECYCLE] ✅ CREATE_BRIDGE PERMITIDO: phase=${currentPhase} - Procediendo a crear bridge`);
                log("info", `🌉 [VOICE BRIDGE] Creando bridge de voz para playback (phase=${currentPhase}, channelId=${channel.id})`);

                const bridgeCreateStart = Date.now();
                voiceBridgeRef.current = ari.Bridge();
                await voiceBridgeRef.current.create({ type: 'mixing,dtmf_events' });
                const bridgeCreateTime = Date.now() - bridgeCreateStart;

                log("info", `🌉 [VOICE BRIDGE] ✅ Bridge de voz creado exitosamente:`, {
                    bridgeId: voiceBridgeRef.current.id,
                    bridgeType: 'mixing,dtmf_events',
                    phase: currentPhase,
                    channelId: channel.id,
                    linkedId: linkedId,
                    creationTimeMs: bridgeCreateTime
                });
            }

            // Asegurar que el canal caller esté en el bridge de voz
            try {
                // 🛡️ VALIDACIÓN CRÍTICA: Verificar que el canal existe y está activo ANTES de operaciones
                let channelState;
                try {
                    channelState = await channel.get();
                    if (!channelState || channelState.state === 'Down') {
                        log("warn", `⚠️ [VOICE BRIDGE] Canal ${channel.id} no disponible (estado: ${channelState?.state || 'null'}), omitiendo bridge setup`);
                        return; // Salir gracefully sin error
                    }
                } catch (channelErr) {
                    if (channelErr.message && (channelErr.message.includes('Channel not found') || channelErr.message.includes('404'))) {
                        log("warn", `⚠️ [VOICE BRIDGE] Canal ${channel.id} ya no existe (hangup temprano), omitiendo bridge setup`);
                        return; // Salir gracefully
                    }
                    throw channelErr; // Re-lanzar otros errores
                }

                const bridgeInfo = await voiceBridgeRef.current.get();
                const isInBridge = Array.isArray(bridgeInfo.channels) && bridgeInfo.channels.includes(channel.id);

                // 🔍 DIAGNÓSTICO: Log del estado del bridge antes de agregar canal
                log("info", `🔍 [VOICE BRIDGE] Estado antes de playback: bridgeId=${voiceBridgeRef.current.id}, bridgeType=${bridgeInfo.bridge_type || 'unknown'}, channels=${bridgeInfo.channels?.length || 0}, callerInBridge=${isInBridge}, channelState=${channelState.state}`);

                if (!isInBridge) {
                    await voiceBridgeRef.current.addChannel({ channel: channel.id });
                    log("info", `🌉 [VOICE BRIDGE] Caller ${channel.id} agregado al bridge ${voiceBridgeRef.current.id}`);

                    // 🛡️ CRÍTICO: Esperar a que el canal esté completamente en el bridge antes de reproducir
                    // Pequeña pausa para asegurar que Asterisk procese el cambio
                    await new Promise(resolve => setTimeout(resolve, 150));

                    // Verificar que el canal está realmente en el bridge
                    const verifyBridge = await voiceBridgeRef.current.get();
                    const isConfirmed = Array.isArray(verifyBridge.channels) && verifyBridge.channels.includes(channel.id);

                    if (!isConfirmed) {
                        log("warn", `⚠️ [VOICE BRIDGE] Canal no confirmado en bridge después de 150ms, reintentando...`);
                        await voiceBridgeRef.current.addChannel({ channel: channel.id });
                        await new Promise(resolve => setTimeout(resolve, 150));

                        // Segunda verificación
                        const finalVerify = await voiceBridgeRef.current.get();
                        const finalConfirmed = Array.isArray(finalVerify.channels) && finalVerify.channels.includes(channel.id);
                        if (!finalConfirmed) {
                            log("error", `❌ [VOICE BRIDGE] Canal ${channel.id} NO pudo ser agregado al bridge ${voiceBridgeRef.current.id} después de 2 intentos`);
                        } else {
                            log("info", `✅ [VOICE BRIDGE] Canal confirmado en bridge después de reintento`);
                        }
                    } else {
                        log("info", `✅ [VOICE BRIDGE] Canal confirmado en bridge`);
                    }
                } else {
                    log("info", `🌉 [VOICE BRIDGE] Caller ${channel.id} ya está en bridge ${voiceBridgeRef.current.id}`);
                }
            } catch (err) {
                if (err.message && (err.message.includes('Channel not found') || err.message.includes('404'))) {
                    log("warn", `⚠️ [VOICE BRIDGE] Canal ${channel.id} ya no existe durante bridge setup, omitiendo`);
                    return; // Salir gracefully
                }
                log("error", `❌ [VOICE BRIDGE] Error verificando/agregando canal: ${err.message}, stack: ${err.stack}`);
            }

            // 🔍 DIAGNÓSTICO PRE-PLAYBACK: Estado completo antes de reproducir
            const prePlaybackState = {
                audioFile: audioFile,
                mediaPath: `sound:voicebot/${audioFile}`,
                bargeIn: !silent,
                voiceBridgeId: voiceBridgeRef?.current?.id || 'none',
                channelId: channel.id,
                captureBridgeId: captureBridge?.id || 'none'
            };
            log("info", `🔍 [PLAYBACK] Pre-playback state: ${JSON.stringify(prePlaybackState)}`);

            // ⭐ MEJORA 1: Verificación explícita de existencia del archivo BVDA
            const VOICEBOT_PATH = config.paths.voicebot || "/var/lib/asterisk/sounds/voicebot";
            const audioPathWav = `${VOICEBOT_PATH}/${audioFile}.wav`;
            const audioPathSlin = `${VOICEBOT_PATH}/${audioFile}.slin`;
            const audioExistsWav = fs.existsSync(audioPathWav);
            const audioExistsSlin = fs.existsSync(audioPathSlin);

            if (!audioExistsWav && !audioExistsSlin) {
                log("error", `❌ [BVDA] Audio BVDA no existe: ${audioFile}`);
                log("error", `❌ [BVDA] Buscado en: ${audioPathWav} (no encontrado)`);
                log("error", `❌ [BVDA] Buscado en: ${audioPathSlin} (no encontrado)`);
                // Continuar de todas formas - Asterisk puede tener el archivo en otro formato o ruta
            } else {
                const foundPath = audioExistsWav ? audioPathWav : audioPathSlin;
                log("info", `✅ [BVDA] Audio BVDA encontrado: ${foundPath}`);
            }

            // ⭐ MEJORA 2: Flag playbackOnly para dominios BVDA puros (desactivar STT)
            if (result.playbackOnly === true) {
                log("info", `🎯 [PLAYBACK_ONLY] Flag activado: desactivando incremental STT para este playback`);
                if (openaiClient && openaiClient.disableIncremental) {
                    openaiClient.disableIncremental();
                    log("info", "🎯 [PLAYBACK_ONLY] Incremental STT desactivado por flag playbackOnly");
                }
            }

            // 🛡️ VALIDACIÓN FINAL CRÍTICA: Verificar que el canal está Up antes de reproducir
            let finalChannelState;
            try {
                finalChannelState = await channel.get();
                if (!finalChannelState || finalChannelState.state !== 'Up') {
                    log("warn", `⚠️ [PLAYBACK] Canal ${channel.id} no está en estado Up (estado: ${finalChannelState?.state || 'null'}), omitiendo playback`);
                    return; // Salir gracefully - no reproducir si el canal no está Up
                }
            } catch (finalErr) {
                if (finalErr.message && (finalErr.message.includes('Channel not found') || finalErr.message.includes('404'))) {
                    log("warn", `⚠️ [PLAYBACK] Canal ${channel.id} ya no existe antes de reproducir, omitiendo playback`);
                    return; // Salir gracefully
                }
                throw finalErr; // Re-lanzar otros errores
            }

            const finalAudioFile = staticFile || audioFile;
            log("info", `▶️ Playing Audio: ${finalAudioFile} (Type: ${botOutput?.type || 'legacy'}, InterruptPolicy: allowBargeIn=${interruptPolicy.allowBargeIn})`);
            log('info', '🗣️ [BOT_SPEAKING]', {
                audio: finalAudioFile,
                outputType: botOutput?.type || 'legacy',
                interruptPolicy: {
                    allowBargeIn: interruptPolicy.allowBargeIn,
                    minSpeechMs: interruptPolicy.minSpeechMs,
                    minConfidence: interruptPolicy.minConfidence
                }
            }); // ✅ OBSERVABILITY LOG

            // 🎯 ESTRATEGIA DE PLAYBACK: Verificar si el canal está en el bridge
            let useBridgePlayback = false;
            if (voiceBridgeRef?.current && finalChannelState.state === 'Up') {
                try {
                    const bridgeCheck = await voiceBridgeRef.current.get();
                    const isInBridge = Array.isArray(bridgeCheck.channels) && bridgeCheck.channels.includes(channel.id);
                    useBridgePlayback = isInBridge && bridgeCheck.channels.length > 0;
                } catch (bridgeErr) {
                    log("warn", `⚠️ [PLAYBACK] Error verificando bridge: ${bridgeErr.message}, usando playback directo`);
                    useBridgePlayback = false;
                }
            }

            if (useBridgePlayback) {
                // ✅ Reproducir sobre bridge si el canal está en el bridge
                // Usar interruptPolicy del dominio (compatible con legacy bargeIn)
                // ✅ ARQUITECTURA DESACOPLADA: WAV y TTS se tratan igual
                await playWithBargeIn(ari, channel, finalAudioFile, openaiClient, {
                    bargeIn: interruptPolicy.allowBargeIn,
                    interruptPolicy: interruptPolicy // Pasar política completa para evaluación avanzada
                }, voiceBridgeRef);

                // 🎯 CRÍTICO: Verificar y re-insertar caller en bridge después del playback
                // Asterisk puede sacar automáticamente el canal del bridge cuando termina el playback
                // El bridge DEBE permanecer activo para LISTEN_RUT (es el bus de audio del bot)
                if (voiceBridgeRef?.current) {
                    try {
                        // 🎯 ESPERA CRÍTICA: Dar tiempo a Asterisk para procesar el fin del playback
                        // Sin esta espera, hay una condición de carrera donde verificamos antes de que Asterisk actualice el estado
                        await new Promise(resolve => setTimeout(resolve, 200));

                        // 🎯 VERIFICACIÓN ROBUSTA: Verificar múltiples veces con reintentos
                        let callerStillInBridge = false;
                        let attempts = 0;
                        const maxAttempts = 3;

                        while (!callerStillInBridge && attempts < maxAttempts) {
                            attempts++;
                            const postPlaybackBridgeInfo = await voiceBridgeRef.current.get();
                            callerStillInBridge = Array.isArray(postPlaybackBridgeInfo.channels) &&
                                postPlaybackBridgeInfo.channels.includes(channel.id);

                            if (!callerStillInBridge) {
                                if (attempts === 1) {
                                    log("warn", `⚠️ [VOICE BRIDGE] Caller ${channel.id} NO está en bridge ${voiceBridgeRef.current.id} después del playback (intento ${attempts}/${maxAttempts}), reinsertando...`);
                                }
                                await voiceBridgeRef.current.addChannel({ channel: channel.id });

                                // Esperar un momento para que Asterisk procese el addChannel
                                await new Promise(resolve => setTimeout(resolve, 150));
                            }
                        }

                        // Verificación final
                        const finalBridgeInfo = await voiceBridgeRef.current.get();
                        const finalChannels = Array.isArray(finalBridgeInfo.channels) ? finalBridgeInfo.channels : [];
                        const finalCheck = finalChannels.includes(channel.id);

                        log("info", `🔒 [LIFECYCLE] Verificación final post-playback:`, {
                            bridgeId: voiceBridgeRef.current.id,
                            channelId: channel.id,
                            attempts: attempts,
                            maxAttempts: maxAttempts,
                            callerInBridge: finalCheck,
                            channelsInBridge: finalChannels,
                            channelCount: finalChannels.length,
                            bridgeType: finalBridgeInfo.bridge_type,
                            phase: currentPhase
                        });

                        if (finalCheck) {
                            log("info", `✅ [VOICE BRIDGE] Caller ${channel.id} confirmado en bridge ${voiceBridgeRef.current.id} después del playback (${attempts} intentos)`);
                        } else {
                            log("error", `❌ [VOICE BRIDGE] Falló mantener caller ${channel.id} en bridge ${voiceBridgeRef.current.id} después de ${maxAttempts} intentos`, {
                                bridgeId: voiceBridgeRef.current.id,
                                channelId: channel.id,
                                attempts: attempts,
                                channelsInBridge: finalChannels,
                                phase: currentPhase
                            });

                            // Último intento desesperado
                            try {
                                log("warn", `⚠️ [VOICE BRIDGE] Último intento desesperado para mantener caller en bridge`);
                                await voiceBridgeRef.current.addChannel({ channel: channel.id });
                                await new Promise(resolve => setTimeout(resolve, 200));
                                const lastCheck = await voiceBridgeRef.current.get();
                                const lastChannels = Array.isArray(lastCheck.channels) ? lastCheck.channels : [];
                                const lastInBridge = lastChannels.includes(channel.id);

                                log("info", `🔒 [LIFECYCLE] Resultado último intento:`, {
                                    bridgeId: voiceBridgeRef.current.id,
                                    channelId: channel.id,
                                    callerInBridge: lastInBridge,
                                    channelsInBridge: lastChannels,
                                    channelCount: lastChannels.length
                                });

                                if (lastInBridge) {
                                    log("info", `✅ [VOICE BRIDGE] Caller ${channel.id} reinsertado en último intento`);
                                } else {
                                    log("error", `❌ [VOICE BRIDGE] Falló mantener caller en bridge después de todos los intentos`, {
                                        bridgeId: voiceBridgeRef.current.id,
                                        channelId: channel.id,
                                        channelsInBridge: lastChannels
                                    });
                                }
                            } catch (lastErr) {
                                log("error", `❌ [VOICE BRIDGE] Error en último intento: ${lastErr.message}`, {
                                    error: lastErr.message,
                                    stack: lastErr.stack,
                                    bridgeId: voiceBridgeRef.current.id,
                                    channelId: channel.id
                                });
                            }
                        }
                    } catch (bridgeCheckErr) {
                        log("error", `❌ [VOICE BRIDGE] Error verificando/reinsertando caller después del playback: ${bridgeCheckErr.message}`);
                    }
                }
            } else {
                // ✅ Reproducir directamente sobre el canal si no hay bridge o el canal no está en el bridge
                log("info", `🔊 [PLAYBACK] Reproduciendo directamente sobre canal (bridge no disponible o canal no en bridge)`);
                try {
                    const playback = ari.Playback();
                    playback.on('PlaybackFinished', () => {
                        log("info", `✅ [PLAYBACK] Playback directo sobre canal completado`);
                    });
                    playback.on('PlaybackFailed', (evt) => {
                        log("error", `❌ [PLAYBACK] Playback directo falló: ${JSON.stringify(evt)}`);
                    });
                    await channel.play({ media: `sound:voicebot/${audioFile}` }, playback);
                    log("info", `✅ [PLAYBACK] Playback directo sobre canal iniciado`);
                } catch (directErr) {
                    log("warn", `⚠️ [PLAYBACK] Error en playback directo: ${directErr.message}`);
                }
            }

            // 🛡️ RE-ATTACH TO CAPTURE BRIDGE (Essential for STT) - pero mantener en voice bridge también
            if (captureBridge) {
                try {
                    // El canal puede estar en ambos bridges simultáneamente (mixing permite esto)
                    await captureBridge.addChannel({ channel: channel.id });
                    log("debug", `🌉 [BRIDGE] Canal también agregado a capture bridge ${captureBridge.id} para STT`);
                } catch (err) {
                    log("warn", `⚠️ [BRIDGE] Error agregando canal a capture bridge: ${err.message}`);
                }
            }
        }
    }

    // 2. TTS / TEXT (Implicit or Explicit)
    const textToSay = result.text || result.ttsText;
    if ((action === 'SAY_TEXT' || textToSay) && !audioFile) {
        // Only say text if no audio file was provided (priority to audio)
        // OR if action explicitly allows it.
        // For now, consistent with legacy: if text exists, send it.
        // BUT strict mode: 'sound:...' should be handled by domain returning audio property, not ttsText.


        if (textToSay) {
            // Guardrail: Detect "sound:" in text and block it
            if (textToSay.startsWith("sound:")) {
                log("warn", `⚠️ [ENGINE] Domain returned 'sound:' in text. This should be 'audio' property. Ignoring TTS.`);
            } else {
                log("info", `🗣️ TTS: "${textToSay}"`);

                // 🎤 CRÍTICO: Asegurar voice bridge también para TTS
                if (!voiceBridgeRef.current) {
                    log("info", `🌉 [VOICE BRIDGE] Creando bridge de voz para TTS`);
                    voiceBridgeRef.current = ari.Bridge();
                    await voiceBridgeRef.current.create({ type: 'mixing,dtmf_events' });
                    log("info", `🌉 [VOICE BRIDGE] Bridge de voz creado: ${voiceBridgeRef.current.id}`);
                }

                try {
                    const bridgeInfo = await voiceBridgeRef.current.get();
                    const isInBridge = Array.isArray(bridgeInfo.channels) && bridgeInfo.channels.includes(channel.id);
                    if (!isInBridge) {
                        await voiceBridgeRef.current.addChannel({ channel: channel.id });
                        log("info", `🌉 [VOICE BRIDGE] Caller ${channel.id} agregado al bridge ${voiceBridgeRef.current.id} para TTS`);
                    }
                } catch (err) {
                    log("warn", `⚠️ [VOICE BRIDGE] Error verificando/agregando canal para TTS: ${err.message}`);
                }

                // ✅ FIX: Actually PLAY the audio and manage STT pause
                // Usar interruptPolicy del dominio (compatible con legacy bargeIn)
                await sendSystemTextAndPlay(ari, channel, openaiClient, textToSay, {
                    bargeIn: interruptPolicy.allowBargeIn
                }, voiceBridgeRef);

                // 🛡️ RE-ATTACH TO CAPTURE BRIDGE (Essential for STT) - same as audio
                if (captureBridge) {
                    try {
                        await captureBridge.addChannel({ channel: channel.id });
                        log("debug", `🌉 [BRIDGE] Canal también agregado a capture bridge ${captureBridge.id} tras TTS`);
                    } catch (err) {
                        log("warn", `⚠️ [BRIDGE] Error agregando canal a capture bridge tras TTS: ${err.message}`);
                    }
                }

                conversationState.history.push({ role: "assistant", content: textToSay });
            }
        }
    }

    // 3. HANGUP
    if (action === 'HANGUP' || result.shouldHangup) {
        log("info", "🛑 Domain requested HANGUP");
    }
}
// UDP Helper
async function setupUdpStream(openaiClient, sttMode, bufferArray) {
    return new Promise((resolve, reject) => {
        const server = dgram.createSocket("udp4");
        server.on("message", (msg) => {
            // Strip RTP header (Min 12 bytes)
            if (msg.length > 12) {
                const payload = msg.slice(12);

                if (sttMode === 'legacy-batch') {
                    // 📼 LEGACY: Buffer raw ulaw
                    bufferArray.push(payload);
                } else {
                    // ⚡ REALTIME: Stream to OpenAI
                    openaiClient.streamAudio(payload);
                }

                // 🔍 DEBUG: Log once every ~50 packets (approx 1 sec)
                if (Math.random() < 0.05) {
                    log("info", `🎧 [STT][RX] Audio recibido (${sttMode})`, {
                        size: payload.length
                    });
                    log('debug', '🎤 [USER_AUDIO_RX]', { size: payload.length, speaking: payload.length > 0 }); // ✅ OBSERVABILITY LOG
                }
            }
        });
        server.on("error", (err) => {
            log("error", `❌ UDP Error: ${err.message}`);
        });
        server.bind(0, () => {
            const addr = server.address();
            log("info", `🎧 UDP RTP Listener started on port ${addr.port}`);
            resolve({ server, port: addr.port });
        });
    });
}

function encodeWav(buffers) {
    const dataLength = buffers.reduce((acc, b) => acc + b.length, 0);
    const buffer = Buffer.concat(buffers, dataLength);
    const header = Buffer.alloc(44);

    // RIFF identifier
    header.write('RIFF', 0);
    // file length
    header.writeUInt32LE(36 + dataLength, 4);
    // RIFF type
    header.write('WAVE', 8);
    // format chunk identifier
    header.write('fmt ', 12);
    // format chunk length
    header.writeUInt32LE(16, 16);
    // sample format (7 = mu-law)
    header.writeUInt16LE(7, 20);
    // channel count
    header.writeUInt16LE(1, 22);
    // sample rate
    header.writeUInt32LE(8000, 24);
    // byte rate
    header.writeUInt32LE(8000, 28);
    // block align
    header.writeUInt16LE(1, 32);
    // bits per sample
    header.writeUInt16LE(8, 34);
    // data chunk identifier
    header.write('data', 36);
    // data chunk length
    header.writeUInt32LE(dataLength, 40);

    return Buffer.concat([header, buffer]);
}

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal (i.e. 127.0.0.1) and non-ipv4
            if ("IPv4" !== iface.family || iface.internal) {
                continue;
            }
            return iface.address;
        }
    }
    return "127.0.0.1"; // Fallback
}
