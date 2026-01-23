/**
 * 💊 Quintero Phased Capsule
 * Implements the phased rollout strategy for the Quintero voicebot.
 * 
 * Logic (LEGO Model):
 * - Phase 1: Greeting -> Farewell -> Hangup
 * - Phase 2: Greeting (Merged Audio) -> Hangup (Zero Listen)
 * - Phase 3: Greeting -> Listen (STT) -> Webhook -> Confirm/Retry
 */
/**
 * 💊 Quintero Phased Capsule
 * Implements the phased rollout strategy for the Quintero voicebot.
 *
 * Logic (LEGO Model):
 * - Phase 1: BVDA (Audio Only) -> Greeting
 * - Phase 2: LISTEN_RUT (Input) -> Redis Buffer -> 2s Silence -> Webhook
 * - Phase 3+: Decision (Valid -> Next/Invalid -> Retry Audio)
 */
import { log } from '../../../../../lib/logger.js';
import { createRedisRutMemory } from '../memory/redisRutMemory.js';
import { createFormatRutWebhook } from '../webhooks/formatRutWebhook.js';
import { domainTrace } from '../utils/domainTrace.js';
import { getPartialRut, getNormalizedPartialRut, isValidPartialRut, clearPartialRut, consolidateRut, getRutState, getConsolidatedRutText } from '../../../../core/engine/incremental-rut-processor.js';
import { IdentityState } from '../../../../core/engine/identity-capture.js';
import redis from '../../../../../lib/redis.js';

// Configuration
// Configuration
// 🎯 URL REAL: Usar variable de entorno (OBLIGATORIA)
// Prioridad: RUT_WEBHOOK_URL > RUT_FORMAT_WEBHOOK_URL (legacy)
const WEBHOOK_URL = process.env.RUT_WEBHOOK_URL || process.env.RUT_FORMAT_WEBHOOK_URL;
if (!WEBHOOK_URL) {
    log('error', '❌ [QUINTERO PHASED] RUT_WEBHOOK_URL no definido en variables de entorno - el webhook no funcionará');
}
const formatRutWebhook = createFormatRutWebhook({ url: WEBHOOK_URL });

const NO_INPUT_GRACE_MS = 800;
const NO_INPUT_PROMPT_MS = 10000;
const TRACE_FILE = 'services/client/quintero/bot/capsules/phased-capsule.js';

class QuinteroPhasedCapsule {
    constructor(phase = 1) {
        const parsedPhase = parseInt(phase, 10);
        this.phase = Number.isFinite(parsedPhase) ? parsedPhase : 1;
        this.deferredPhase = null;
        if (this.phase >= 3) {
            // Defer Phase 3 until after the greeting (INIT should never start in Phase 3).
            this.deferredPhase = this.phase;
            this.phase = 1;
        }
        this.currentState = 'START_GREETING'; // Initial bootstrap state
        this.retryCount = 0;
        this.maxRetries = 2;
        this.rutAttemptCount = 0; // 🎯 NUEVO: Contador de intentos de captura de RUT
        this.farewellPlayed = false;
        this.log = log;

        log('info', `💊 [QUINTERO PHASED] Initialized with Phase ${this.phase}`);
    }

    emit(ctx, meta) {
        const res = meta.res;
        domainTrace(this.log, {
            file: TRACE_FILE,
            fn: meta.fn,
            event: meta.event ?? ctx?.event ?? ctx?.eventType ?? 'UNKNOWN',
            phaseIn: meta.phaseIn ?? this.currentState,
            phaseOut: meta.phaseOut ?? res?.nextPhase ?? res?.phase,
            action: meta.action ?? res?.action,
            silent: meta.silent ?? res?.silent,
            skipInput: meta.skipInput ?? res?.skipInput ?? res?.skipUserInput,
            audio: meta.audio ?? res?.audio,
            tts: meta.tts ?? res?.ttsText,
            nextPhase: meta.nextPhase ?? res?.nextPhase
        });
        return res;
    }

    // Helper to enforce state rules by phase
    normalizeStateByPhase(state) {
        if (this.phase >= 3) {
            // Strict mapping for Phase 3+
            if (state === 'WAIT_RUT') return 'LISTEN_RUT';
            if (!state) return 'START_GREETING';
        }
        return state || 'START_GREETING';
    }

    // Main entry point
    async process(ctx) {
        const event = ctx.event || 'START';
        const transcript = ctx.transcript ?? '';
        const webhookData = ctx.webhookData || {};

        let recoveredState = ctx.state?.phasedCurrentState;
        this.currentState = this.normalizeStateByPhase(recoveredState);
        // If the last intent was LISTEN_RUT, do not re-enter greeting on NO_INPUT.
        if (this.currentState === 'START_GREETING' && ctx.state?.rutPhase === 'LISTEN_RUT') {
            this.currentState = 'LISTEN_RUT';
        }
        // Prevent double BVDA after greeting already played
        if (this.currentState === 'START_GREETING' && ctx.state?.phasedGreetingPlayed) {
            this.currentState = 'LISTEN_RUT';
        }

        this.retryCount = ctx.state?.phasedRetryCount || 0;
        this.rutAttemptCount = ctx.state?.phasedRutAttemptCount || 0; // 🎯 NUEVO: Restaurar contador de intentos RUT
        this.farewellPlayed = ctx.state?.phasedFarewellPlayed || false;

        log('info', `💊 [QUINTERO PHASED] Processing Event: ${event} in State: ${this.currentState} (Phase ${this.phase})`);

        let result;

        // 🪝 HANDLE WEBHOOK RESPONSE (Legacy/Adapter path)
        if (event === 'WEBHOOK_RESPONSE') {
            result = this.handleWebhookResponse(webhookData);
        } else {
            // STATE MACHINE
            switch (this.currentState) {
                // 🟦 FASE 1: BVDA (AUDIO ONLY)
                case 'START_GREETING':
                case 'BVDA':
                    result = this.handleBvda(ctx, event);
                    break;

                // 🟦 FASE 2: LISTEN_RUT (BUFFER + SILENCE)
                case 'LISTEN_RUT':
                    result = await this.handleListenRut(event, transcript, ctx);
                    break;

                case 'PROCESS_RUT':
                    result = await this.handleProcessRut(ctx);
                    break;

                case 'CONFIRM_RUT':
                    result = await this.handleConfirmRut(ctx);
                    break;

                case 'VALIDATE_PATIENT':
                    result = await this.handleValidatePatient(ctx);
                    break;

                case 'END_CALL':
                default:
                    result = this.emit(ctx, {
                        fn: 'endCall:default',
                        res: this.endCall()
                    });
                    break;
            }
        }

        // Persist state
        const persistedState =
            (result?.action === 'PLAY_AUDIO' && result?.nextPhase === 'LISTEN_RUT')
                ? 'LISTEN_RUT'
                : (result?.action === 'SET_STATE' && result?.phase === 'LISTEN_RUT')
                    ? 'LISTEN_RUT'
                    : (result?.action === 'SET_STATE' && result?.nextPhase === 'LISTEN_RUT')
                        ? 'LISTEN_RUT'
                        : this.currentState;
        this.emit(ctx, {
            fn: 'persistState',
            phaseIn: this.currentState,
            phaseOut: persistedState,
            action: result?.action,
            silent: result?.silent,
            skipInput: result?.skipInput ?? result?.skipUserInput,
            audio: result?.audio,
            tts: result?.ttsText,
            nextPhase: result?.nextPhase,
            res: { nextPhase: result?.nextPhase }
        });
        
        // 🔐 CRITICAL: Cuando se transiciona a LISTEN_RUT, SIEMPRE limpiar flags silenciosos
        // Si el resultado es SET_STATE con silent=false y skipInput=false, usar esos valores
        // Si viene de PLAY_AUDIO, limpiar para que el siguiente turno establezca los valores correctos
        const isTransitioningToListenRut = persistedState === 'LISTEN_RUT';
        const isSetStateWithListenFlags = result?.action === 'SET_STATE' && 
                                         result?.silent === false && 
                                         (result?.skipInput === false || result?.skipUserInput === false);
        
        result.state = {
            ...ctx.state,
            phasedCurrentState: persistedState,
            phasedRetryCount: this.retryCount,
            phasedRutAttemptCount: this.rutAttemptCount, // 🎯 NUEVO: Persistir contador de intentos RUT
            phasedFarewellPlayed: this.farewellPlayed,
            phasedGreetingPlayed: Boolean(ctx.state?.phasedGreetingPlayed)
                || Boolean(result?.audio === 'quintero/greeting_sofia_2'),
            rutPhase: result.nextPhase,
            // ✅ REGLA DE ORO: LISTEN_RUT solo funciona con silent=false y skipInput=false
            // Si estamos transicionando a LISTEN_RUT y el resultado es SET_STATE con flags correctos, usarlos
            // Si venimos de PLAY_AUDIO, limpiar para que el siguiente turno los establezca
            silent: isTransitioningToListenRut && isSetStateWithListenFlags
                ? false  // ✅ Usar el valor explícito del SET_STATE
                : (isTransitioningToListenRut && result?.action === 'PLAY_AUDIO')
                    ? undefined  // Limpiar para que el siguiente turno lo establezca
                    : result?.silent,
            skipInput: isTransitioningToListenRut && isSetStateWithListenFlags
                ? false  // ✅ Usar el valor explícito del SET_STATE
                : (isTransitioningToListenRut && result?.action === 'PLAY_AUDIO')
                    ? undefined  // Limpiar para que el siguiente turno lo establezca
                    : (result?.skipInput ?? result?.skipUserInput)
        };

        return result;
    }

    // 🟦 FASE 1: BVDA (AUDIO ONLY)
    handleBvda(ctx, event) {
        const phaseIn = this.currentState;
        const effectivePhase = (event === 'INIT') ? 1 : (this.deferredPhase ?? this.phase);

        // After greeting playback, transition into LISTEN_RUT instead of replaying BVDA
        if (event === 'TURN' && (ctx.state?.phasedGreetingPlayed || ctx.state?.rutPhase === 'START_GREETING')) {
            this.currentState = 'LISTEN_RUT';
            const res = {
                phase: 'LISTEN_RUT',
                action: 'SET_STATE',
                nextPhase: 'LISTEN_RUT',
                skipInput: false,
                silent: false,
                config: { listenTimeout: 10000 }
            };
            return this.emit(ctx, {
                fn: 'handleBvda:postGreetingListen',
                phaseIn,
                phaseOut: 'LISTEN_RUT',
                res
            });
        }

        // INIT nunca evalua Phase 3, pero debe permitir greeting -> LISTEN_RUT si hay deferredPhase.
        if (event === 'INIT' && this.deferredPhase) {
            log('info', '💊 [QUINTERO PHASED] INIT: Greeting -> LISTEN_RUT (deferred)');
            this.currentState = 'START_GREETING';
            const res = {
                phase: 'START_GREETING',
                action: 'PLAY_AUDIO',
                audio: 'quintero/greeting_sofia_2',
                ttsText: null, // ❌ NO TTS
                nextPhase: 'LISTEN_RUT',
                silent: true, // ✅ playback
                skipInput: true, // ❌ NO LISTENING during greeting
                allowBargeIn: false, // ❌ NO BARGE-IN
                config: { listenTimeout: 15000 } // ⏱️ Pre-configure next turn's listenTimeout
            };
            return this.emit(ctx, {
                fn: 'handleBvda:greeting',
                phaseIn,
                phaseOut: 'START_GREETING',
                res
            });
        }
        // Phase 3+: Play Greeting -> Listen
        if (effectivePhase >= 3) {
            log('info', '💊 [QUINTERO PHASED] Phase 1: BVDA -> Greeting');
            this.currentState = 'START_GREETING';
            const res = {
                phase: 'START_GREETING',
                action: 'PLAY_AUDIO',
                audio: 'quintero/greeting_sofia_2',
                ttsText: null, // ❌ NO TTS
                nextPhase: 'LISTEN_RUT',
                // Disable barge-in during greeting to ensure VAD sees speech start
                silent: true,
                skipInput: true, // ❌ NO LISTENING during greeting
                allowBargeIn: false // ❌ NO BARGE-IN
            };
            return this.emit(ctx, {
                fn: 'handleBvda:greeting',
                phaseIn,
                phaseOut: 'START_GREETING',
                res
            });
        }

        // Phase 2: Greeting -> End
        if (this.phase === 2) {
            this.currentState = 'END_CALL';
            const res = {
                audio: 'quintero/greeting_sofia_2',
                ttsText: null,
                nextPhase: 'END_CALL',
                silent: true,
                skipInput: true,
                allowBargeIn: false,
                action: 'PLAY_AUDIO'
            };
            return this.emit(ctx, {
                fn: 'handleBvda:phase=2',
                phaseIn,
                res
            });
        }

        // Phase 1 (Legacy default)
        this.currentState = 'END_CALL';
        const res = {
            audio: 'quintero/greeting_sofia_2',
            ttsText: null,
            nextPhase: 'END_CALL',
            silent: true,
            skipInput: true,
            allowBargeIn: false,
            action: 'PLAY_AUDIO'
        };
        return this.emit(ctx, {
            fn: 'handleBvda:phase=1',
            phaseIn,
            res
        });
    }

    // 🟦 FASE 2: LISTEN_RUT (BUFFER + PROCESSING)
    async handleListenRut(event, transcript, ctx) {
        const callKey = ctx.linkedId || ctx.sessionId;
        if (!callKey) {
            return this.emit(ctx, {
                fn: 'handleListenRut:noCallKey',
                res: this.endCall()
            });
        }

        // 🎯 MEJORA 4: El dominio NO debe reprocesar si hay identidad validada
        const rutState = await getRutState(callKey);
        if (rutState.state === IdentityState.VALIDADO && rutState.confidence >= 85) {
            log('info', `🔒 [QUINTERO PHASED] RUT ya VALIDADO: "${rutState.normalized}" (confidence=${rutState.confidence}) -> Avanzando sin reprocesar`);
            
            // Consolidar si aún no está consolidado
            if (rutState.normalized) {
                await consolidateRut(callKey, rutState.normalized);
            }
            
            // 🎯 FIX: Ejecutar handleProcessRut inmediatamente en lugar de solo cambiar estado
            this.currentState = 'PROCESS_RUT';
            return await this.handleProcessRut(ctx);
        }

        if (this.deferredPhase && this.phase < 3) {
            this.phase = this.deferredPhase;
            this.deferredPhase = null;
        }

        const mem = createRedisRutMemory(callKey);
        const now = Date.now();
        const isSpeaking = ctx.speaking === true
            || ctx.session?.speaking === true
            || ctx.state?.speaking === true;
        const transcriptText = (typeof transcript === 'string')
            ? transcript
            : (transcript?.text ?? transcript?.transcript ?? transcript?.value ?? '');
        const hasTranscript = typeof transcriptText === 'string' && transcriptText.trim().length > 0;

        // 🎯 INCREMENTAL RUT: Consultar Redis para RUT parcial válido
        // Esto permite avanzar sin esperar silencio o commit final
        if (!hasTranscript) {
            const rutState = await getRutState(callKey);
            
            // 🎯 REGLA: Avanzar si está VALIDADO con alta confianza (≥85)
            if (rutState.state === IdentityState.VALIDADO && rutState.confidence >= 85) {
                log('info', `🎯 [QUINTERO PHASED] Incremental RUT VALIDADO detected: "${rutState.normalized}" (confidence=${rutState.confidence}) -> Consolidando y procesando`);
                
                // 🎯 CONSOLIDAR: Guardar RUT final antes de procesar
                await consolidateRut(callKey, rutState.normalized);
                
                // Obtener texto RAW para procesamiento completo
                const rawRut = rutState.partial || rutState.normalized;
                
                await mem.appendText(rawRut, now);
                await clearPartialRut(callKey); // Limpiar buffer después de consolidar
                // 🎯 FIX: Ejecutar handleProcessRut inmediatamente en lugar de solo cambiar estado
                this.currentState = 'PROCESS_RUT';
                return await this.handleProcessRut(ctx);
            }
        }

            // 0. INPUT RECEIVED (Transcript Present) -> PROCESS_RUT
        if ((event === 'INPUT_RECEIVED' || event === 'TURN') && hasTranscript) {
            log('info', `💊 [QUINTERO PHASED] Input: "${transcriptText}" -> Buffer + PROCESS_RUT`);

            // 🎯 CRÍTICO: Antes de procesar, consolidar RUT si es válido
            // El transcript puede venir del buffer parcial acumulado en Redis
            const rutState = await getRutState(callKey);
            log('debug', `🔍 [QUINTERO PHASED] Estado RUT en INPUT/TURN: state=${rutState.state}, normalized="${rutState.normalized}", confidence=${rutState.confidence}`);

            // 🎯 REGLA: Consolidar si está VALIDADO o COMPLETO_SIN_DV con suficiente confianza
            if (rutState.state === IdentityState.VALIDADO ||
                (rutState.state === IdentityState.COMPLETO_SIN_DV && rutState.normalized && rutState.normalized.length >= 7)) {
                log('info', `🎯 [QUINTERO PHASED] RUT válido detectado en INPUT/TURN: "${rutState.normalized}" (state=${rutState.state}, confidence=${rutState.confidence}) -> Consolidando`);
                await consolidateRut(callKey, rutState.normalized);
            } else if (rutState.normalized && rutState.normalized.length > 0) {
                log('debug', `⚠️ [QUINTERO PHASED] RUT encontrado pero no consolidable: "${rutState.normalized}" (state=${rutState.state}, length=${rutState.normalized.length})`);
            }

            await mem.appendText(transcriptText, now);
            // Limpiar buffer incremental después de consolidar (si se consolidó) o si no era válido
            await clearPartialRut(callKey);
            
            // 🎯 FIX: Ejecutar handleProcessRut inmediatamente en lugar de solo cambiar estado
            this.currentState = 'PROCESS_RUT';
            return await this.handleProcessRut(ctx);
        }

        // 🎯 CRITICAL: INIT ENTRY (Opening Mic)
        // ✅ REGLA DE ORO: LISTEN_RUT solo se abre cuando action === SET_STATE y silent === false
        // Si no hay transcript, SIEMPRE debemos abrir la escucha lógica con SET_STATE explícito
        // Esto garantiza que el dominio entre en "LISTEN lógico" y consuma transcripts del engine
        
        // Detectar si venimos de un greeting (estado previo con silent=true)
        const comingFromGreeting = ctx.state?.phasedGreetingPlayed || 
                                   ctx.state?.rutPhase === 'START_GREETING' ||
                                   (ctx.state?.silent === true && ctx.state?.skipInput === true);
        
        // Si es INIT, TURN sin transcript, o venimos de greeting → FORZAR apertura de escucha
        if (event === 'INIT' || (event === 'TURN' && !hasTranscript) || comingFromGreeting) {
            // 🎯 FIX A: Evitar re-entrada a escucha usando enteredListenTs como candado
            const snap = await mem.getSnapshot();
            if (snap.enteredListenTs && snap.enteredListenTs > 0) {
                // Ya estamos en modo escucha, no reinicializar
                log('info', `🔒 [QUINTERO PHASED] LISTEN_RUT: Ya en modo escucha (enteredListenTs=${snap.enteredListenTs}), NO reinicializando`);
                const res = {
                    phase: 'LISTEN_RUT',
                    action: 'SET_STATE',
                    nextPhase: 'LISTEN_RUT',
                    skipInput: false,
                    silent: false,
                    enableIncremental: true,
                    config: { listenTimeout: 15000 }
                };
                return this.emit(ctx, {
                    fn: 'handleListenRut:alreadyListening',
                    res
                });
            }
            
            // 🎯 NUEVO: Incrementar contador de intentos RUT
            this.rutAttemptCount++;
            const isFirstRutAttempt = this.rutAttemptCount === 1;
            
            // 🎯 NUEVO: Tiempos diferenciados - primer intento más largo, reintentos más cortos
            // Primer intento: 4.5s (usuario se adapta, habla más lento, necesita más contexto)
            // Reintentos: 2.5s (usuario ya sabe qué decir, más directo)
            const listenTimeout = isFirstRutAttempt ? 4500 : 2500;
            
            log('info', `💊 [QUINTERO PHASED] LISTEN_RUT: Opening Mic (attempt ${this.rutAttemptCount}/${isFirstRutAttempt ? 'FIRST' : 'RETRY'}) - timeout=${listenTimeout}ms`);
            
            // 🕒 AUDITORÍA: Inicio del evento RUT_CAPTURE_START
            const tListenStart = Date.now();
            
            // Primera vez entrando a escucha - inicializar
            const tInitStart = Date.now();
            await mem.initListenWindow(now);
            const tInitEnd = Date.now();
            const initTime = tInitEnd - tInitStart;
            
            // 🎯 FIX C: NO borrar id:RUT:* al iniciar - solo limpiar si no existe enteredListenTs previo
            // (clearPartialRut ya no se llama aquí para evitar borrar datos válidos)
            log('info', '💊 [QUINTERO PHASED] LISTEN_RUT: Opening Mic (Redis Buffer Init) - FORCING SET_STATE with silent=false', {
                initTime: `${initTime}ms`,
                attempt: this.rutAttemptCount,
                isFirstAttempt: isFirstRutAttempt,
                listenTimeout: `${listenTimeout}ms`,
                status: initTime <= 20 ? 'IDEAL' : initTime <= 50 ? 'ACEPTABLE' : 'LENTO'
            });
            
            // 🕒 AUDITORÍA: Tiempo total de inicialización
            const tListenEnd = Date.now();
            const listenInitTime = tListenEnd - tListenStart;
            log('info', `⏱️ [QUINTERO PHASED][TIMING] RUT_CAPTURE_START`, {
                callId: callKey,
                initTime: `${initTime}ms`,
                total: `${listenInitTime}ms`,
                attempt: this.rutAttemptCount,
                listenTimeout: `${listenTimeout}ms`,
                status: listenInitTime <= 20 ? 'IDEAL' : 'ACEPTABLE'
            });

            const res = {
                phase: 'LISTEN_RUT',
                action: 'SET_STATE', // ✅ CRÍTICO: Debe ser SET_STATE, no PLAY_AUDIO
                nextPhase: 'LISTEN_RUT',
                skipInput: false, // ✅ OPEN STT
                silent: false, // ✅ allow real listening - CRÍTICO: sin esto el dominio nunca escucha
                enableIncremental: true, // 🎯 CONTRATO: Dominio activa incremental explícitamente
                config: { listenTimeout: listenTimeout } // 🎯 NUEVO: Tiempo diferenciado según intento
            };
            return this.emit(ctx, {
                fn: 'handleListenRut:init',
                res
            });
        }

        // 2. INPUT RECEIVED
        if ((event === 'INPUT_RECEIVED' || event === 'TURN') && transcript) {
            // Transcript content already handled above (PROCESS_RUT)
        }

        // 3. NO INPUT / TIMEOUT
        if (event === 'NO_INPUT') {
            // 🎯 MEJORA 4: Verificar RUT validado ANTES de procesar NO_INPUT
            const rutStateNoInput = await getRutState(callKey);
            if (rutStateNoInput.state === IdentityState.VALIDADO && rutStateNoInput.confidence >= 85) {
                log('info', `🔒 [QUINTERO PHASED] NO_INPUT: RUT ya VALIDADO: "${rutStateNoInput.normalized}" (confidence=${rutStateNoInput.confidence}) -> Avanzando sin reprocesar`);
                
                // Consolidar si aún no está consolidado
                if (rutStateNoInput.normalized) {
                    await consolidateRut(callKey, rutStateNoInput.normalized);
                }

                // 🎯 FIX: Ejecutar handleProcessRut inmediatamente en lugar de solo cambiar estado
                this.currentState = 'PROCESS_RUT';
                return await this.handleProcessRut(ctx);
            }
            
            const snap = await mem.getSnapshot();
            const nowMs = Date.now();

            if (!snap.enteredListenTs) {
                await mem.initListenWindow(nowMs);
                log('info', '💊 [QUINTERO PHASED] NO_INPUT: initializing listen window');
                const res = {
                    nextPhase: 'LISTEN_RUT',
                    action: 'SET_STATE',
                    skipInput: false,
                    silent: false,
                    config: { listenTimeout: NO_INPUT_PROMPT_MS }
                };
                return this.emit(ctx, {
                    fn: 'handleListenRut:noInputInitListen',
                    res
                });
            }

            if (isSpeaking) {
                log('info', '💊 [QUINTERO PHASED] NO_INPUT ignored (speaking=true)');
                const res = {
                    nextPhase: 'LISTEN_RUT',
                    action: 'SET_STATE',
                    skipInput: false,
                    silent: false,
                    config: { listenTimeout: NO_INPUT_PROMPT_MS }
                };
                return this.emit(ctx, {
                    fn: 'handleListenRut:noInputSpeaking',
                    res
                });
            }

            if (snap.enteredListenTs && (nowMs - snap.enteredListenTs) < NO_INPUT_GRACE_MS) {
                log('info', `💊 [QUINTERO PHASED] NO_INPUT ignored (grace ${NO_INPUT_GRACE_MS}ms)`);
                const res = {
                    nextPhase: 'LISTEN_RUT',
                    action: 'SET_STATE',
                    skipInput: false,
                    silent: false,
                    config: { listenTimeout: NO_INPUT_PROMPT_MS }
                };
                return this.emit(ctx, {
                    fn: 'handleListenRut:noInputGrace',
                    res
                });
            }

            // 🚑 FAIL-SAFE: Rescue STT from Session Context if Engine didn't pass it in event
            // The engine might have the text in session.stt_latest or similar but failed to map it to transcript.
            const rescuedText = ctx.session?.text || ctx.session?.transcript || ctx.session?.lastUserText;

            if (rescuedText && typeof rescuedText === 'string' && rescuedText.trim().length > 0) {
                log('warn', `🚑 [QUINTERO] Rescued STT text from session: "${rescuedText}"`);
                // Recursively handle as valid input
                return this.handleListenRut('INPUT_RECEIVED', rescuedText, ctx);
            }

            // If buffer has content, maybe we process it?
            if (snap.buffer && snap.buffer.length > 0) {
                // Treated same as input received above, but triggered by timeout?
                // Usually NO_INPUT means strict silence.
            }

            // 🎯 CRÍTICO: NO_INPUT ≠ RESET
            // NO_INPUT solo reevalúa, NO limpia prematuramente
            // Consultar estado completo de RUT (incluyendo confidence) ANTES de decidir
            const rutState = await getRutState(callKey);
            
            log('debug', `🔍 [QUINTERO PHASED] Estado RUT en NO_INPUT: state=${rutState.state}, normalized="${rutState.normalized}", confidence=${rutState.confidence}, tokens=${rutState.tokens?.length || 0}`);
            
            // 🎯 REGLA: Si hay RUT VALIDADO (completo con DV válido), consolidar y avanzar
            if (rutState.state === IdentityState.VALIDADO && rutState.confidence >= 85) {
                log('info', `🎯 [QUINTERO PHASED] RUT VALIDADO detectado en NO_INPUT: "${rutState.normalized}" (confidence=${rutState.confidence}) -> Consolidando y procesando`);
                
                // Obtener texto RAW para procesamiento completo
                const rawRut = rutState.partial || rutState.normalized;
                
                // Consolidar RUT (guardar como RUT final)
                await consolidateRut(callKey, rutState.normalized);
                
                // Procesar como input recibido
                await mem.appendText(rawRut, nowMs);
                await clearPartialRut(callKey); // Limpiar buffer después de consolidar

                // 🎯 FIX: Ejecutar handleProcessRut inmediatamente en lugar de solo cambiar estado
                this.currentState = 'PROCESS_RUT';
                return await this.handleProcessRut(ctx);
            }
            
            // 🎯 REGLA: Si hay RUT COMPLETO_SIN_DV (cuerpo válido, DV pendiente)
            // Opcional: consolidar cuerpo y pedir DV explícitamente
            if (rutState.state === IdentityState.COMPLETO_SIN_DV && rutState.normalized && rutState.normalized.length >= 7) {
                log('info', `🎯 [QUINTERO PHASED] RUT COMPLETO_SIN_DV detectado en NO_INPUT: "${rutState.normalized}" (confidence=${rutState.confidence}) -> Consolidando cuerpo, DV pendiente`);
                
                // Consolidar el cuerpo (aunque falte DV)
                await consolidateRut(callKey, rutState.normalized);
                
                const rawRut = rutState.partial || rutState.normalized;
                await mem.appendText(rawRut, nowMs);
                await clearPartialRut(callKey);

                // 🎯 FIX: Ejecutar handleProcessRut inmediatamente en lugar de solo cambiar estado
                this.currentState = 'PROCESS_RUT';
                return await this.handleProcessRut(ctx);
            }
            
            // 🎯 MEJORA 4: Limpieza de buffer menos agresiva
            // NO_INPUT solo reinicia timers, NO borra rawBuffer si fue hace <2s
            // Solo limpiar en casos específicos:
            // - INVALIDO definitivo
            // - MAX_ATTEMPTS
            // - No hay nada útil Y han pasado >2s desde último token
            
            const shouldClear = 
                rutState.state === IdentityState.INVALIDO || // Estado definitivamente inválido
                (!rutState.normalized || rutState.normalized.length === 0); // No hay nada útil
            
            if (shouldClear) {
                if (rutState.state === IdentityState.INVALIDO) {
                    log('warn', `❌ [QUINTERO PHASED] RUT INVALIDO detectado en NO_INPUT: "${rutState.normalized}" (reason: ${rutState.reason || 'unknown'}) -> Limpiando y retry`);
                } else {
                    log('debug', `🧹 [QUINTERO PHASED] NO_INPUT sin RUT útil -> Limpiando buffer`);
                }
                await clearPartialRut(callKey);
            } else {
                // 🎯 MEJORA 4: NO limpiar si hay RUT parcial útil
                log('debug', `⚠️ [QUINTERO PHASED] RUT parcial encontrado en NO_INPUT: "${rutState.normalized}" (state=${rutState.state}, ${rutState.normalized.length} dígitos) -> MANTENIENDO buffer para siguiente intento`);
                // NO limpiar el buffer, mantener para el siguiente intento
            }

            const attempts = await mem.incAttempts();
            log('info', `💊 [QUINTERO PHASED] Timeout (No Input). Attempts: ${attempts}`);

            const nextAudio = (attempts <= 1) ? 'quintero/ask_rut' : 'quintero/ask_rut_retry';

            if (attempts > this.maxRetries) {
                return this.emit(ctx, {
                    fn: 'handleListenRut:noInputMaxRetries',
                    res: this.transferOrHangup()
                });
            }

            const res = {
                audio: nextAudio,
                nextPhase: 'LISTEN_RUT',
                skipInput: true, // Play audio
                // Playback: no listening during prompt
                silent: true,
                allowBargeIn: false,
                action: 'PLAY_AUDIO',
                enableIncremental: true // 🎯 CONTRATO: Mantener incremental activo después de re-prompt
            };
            return this.emit(ctx, {
                fn: 'handleListenRut:noInputPrompt',
                phaseOut: 'PROMPT_RUT',
                res
            });
        }

        return this.emit(ctx, {
            fn: 'handleListenRut:default',
            res: this.endCall()
        });
    }

    // 🟦 FASE 3: PROCESS_RUT (Validate + Decide)
    async handleProcessRut(ctx) {
        const callKey = ctx.linkedId || ctx.sessionId;
        if (!callKey) {
            return this.emit(ctx, {
                fn: 'handleProcessRut:noCallKey',
                res: this.endCall()
            });
        }

        const mem = createRedisRutMemory(callKey);
        const snap = await mem.getSnapshot();
        
        // 🎯 RUTA RÁPIDA (LOCAL): Verificar si parser local detecta RUT válido
        // Esto permite avanzar inmediatamente sin esperar webhook
        const rutState = await getRutState(callKey);
        
        // 🎯 MEJORA: Confidence threshold adaptativo
        const getConfidenceThreshold = (attempts) => {
            // Primera vez: más estricto (90)
            if (attempts === 0) return 90;
            // Segundo intento: más permisivo (85)
            if (attempts === 1) return 85;
            // Tercer intento+: muy permisivo (75) para no perder oportunidades
            return 75;
        };
        
        const attemptsForThreshold = snap.attempts || 0;
        const threshold = getConfidenceThreshold(attemptsForThreshold);
        
        if (rutState.state === IdentityState.VALIDADO && rutState.confidence >= threshold) {
            log('info', `🚀 [RUTA RÁPIDA] RUT válido detectado localmente: "${rutState.normalized}" (confidence=${rutState.confidence}, threshold=${threshold}, attempts=${attemptsForThreshold}) → Avanzando sin esperar webhook`);
            
            // Consolidar RUT si aún no está consolidado
            if (rutState.normalized) {
                await consolidateRut(callKey, rutState.normalized);
            }
            
            // Avanzar inmediato (no esperar webhook)
            const rutFormatted = rutState.normalized;
            await redis.set(`rut:formatted:${callKey}`, rutFormatted, { EX: 300 });
            
            this.currentState = 'CONFIRM_RUT';
            const res = {
                action: 'SET_STATE',
                nextPhase: 'CONFIRM_RUT',
                silent: false,
                skipUserInput: false,
                enableIncremental: false
            };
            return this.emit(ctx, {
                fn: 'handleProcessRut:fastPath->confirm',
                res
            });
        }
        
        // 🎯 RUTA LENTA (WEBHOOK): Verificar resultado del webhook si no hay detección local
        // El engine ya llamó al webhook cuando detectó silencio
        const webhookResultKey = `rut:validated:${callKey}`;
        const webhookResultStr = await redis.get(webhookResultKey);
        
        // 🎯 NUEVO: Verificar también si el filtro semántico rechazó el texto
        const webhookRejectKey = `rut:webhook:rejected:${callKey}`;
        const webhookRejectStr = await redis.get(webhookRejectKey);
        
        let result = null;
        
        if (webhookResultStr) {
            // El engine ya llamó al webhook - usar su resultado
            try {
                result = JSON.parse(webhookResultStr);
                log('info', `💊 [QUINTERO PHASED] Usando resultado del webhook (engine): ok=${result.ok}, rut=${result.rut || 'N/A'}`);
                // Limpiar la key después de usarla
                await redis.del(webhookResultKey);
            } catch (e) {
                log('warn', `⚠️ [QUINTERO PHASED] Error parseando resultado del webhook: ${e.message}`);
            }
        } else if (webhookRejectStr) {
            // El filtro semántico rechazó el texto antes de llamar al webhook
            try {
                result = JSON.parse(webhookRejectStr);
                log('info', `💊 [QUINTERO PHASED] Usando resultado del filtro semántico (engine): ok=${result.ok}, reason=${result.reason || 'N/A'}`);
                // Limpiar la key después de usarla
                await redis.del(webhookRejectKey);
            } catch (e) {
                log('warn', `⚠️ [QUINTERO PHASED] Error parseando resultado del filtro semántico: ${e.message}`);
            }
        }
        
        // 🎯 ARQUITECTURA CORRECTA: El dominio NO debe llamar al webhook
        // El engine es el único responsable de ejecutar efectos técnicos (HTTP)
        // El dominio solo consume resultados y decide flujo
        if (!result) {
            log('warn', `⚠️ [QUINTERO PHASED] No hay resultado del engine - el webhook debe ser invocado por el engine cuando detecte silencio suficiente. Esperando...`);
            // NO llamar al webhook desde aquí - esto rompe la arquitectura
            // El engine debe detectar silencio >= MIN_SILENCE_MS y ejecutar el webhook
            // Si llegamos aquí, significa que:
            // 1. El silencio fue insuficiente (< MIN_SILENCE_MS)
            // 2. El webhook aún no se ha ejecutado
            // 3. Debemos esperar al próximo TURN o timeout
            result = null; // Dejar null para que el dominio maneje el retry
        }

        if (result && result.ok) {
            log('info', `💊 [QUINTERO PHASED] ✅ Validated: ${result.rut}`);
            
            // 🎯 FLUJO LEGACY: Guardar RUT y avanzar a CONFIRM_RUT (no terminar llamada)
            // El usuario debe confirmar antes de validar paciente
            const rutFormatted = result.rut;
            
            // Guardar RUT en Redis para que CONFIRM_RUT lo use
            await redis.set(`rut:formatted:${callKey}`, rutFormatted, { EX: 300 });
            
            this.currentState = 'CONFIRM_RUT';
            const res = {
                action: 'SET_STATE',
                nextPhase: 'CONFIRM_RUT',
                silent: false, // Necesitamos escuchar la confirmación
                skipUserInput: false,
                enableIncremental: false // Desactivar incremental durante confirmación
            };
            return this.emit(ctx, {
                fn: 'handleProcessRut:validated->confirm',
                res
            });
        }

        const attempts = await mem.incAttempts();
        await mem.resetBuffer();
        
        // 🎯 MEJORA: Tracking granular por tipo de error
        const errorType = result?.reason || 'UNKNOWN';
        const errorTrackingKey = `rut:errors:${callKey}`;
        const errorCount = await redis.incr(`${errorTrackingKey}:${errorType}`);
        await redis.expire(`${errorTrackingKey}:${errorType}`, 300);
        
        // 🎯 MEJORA: Métricas agregadas en Redis
        const metricsKey = `rut:metrics:${callKey}`;
        const semanticRejects = parseInt(await redis.get(`${errorTrackingKey}:CARDINAL_NUMBER`) || '0', 10);
        const webhookRejects = parseInt(await redis.get(`${errorTrackingKey}:INVALID_RUT_FORMAT`) || '0', 10);
        await redis.hSet(metricsKey, {
            totalAttempts: String(attempts),
            lastErrorType: errorType,
            lastErrorTime: String(Date.now()),
            semanticRejects: String(semanticRejects),
            webhookRejects: String(webhookRejects)
        });
        await redis.expire(metricsKey, 600);
        
        log('info', `💊 [QUINTERO PHASED] ❌ Invalid RUT. Attempts: ${attempts}, ErrorType: ${errorType}, Count: ${errorCount}`);

        // 🎯 MEJORA: Mensajes de error específicos por tipo
        const getRetryMessage = (errorType, attempts) => {
            const messages = {
                'CARDINAL_NUMBER': 'Por favor, dígame su RUT número por número, usando el teclado si es necesario.',
                'CONFUSION_PHRASE': 'Por favor, dígame solo su RUT, sin información adicional.',
                'INSUFFICIENT_DIGITS': 'Necesito escuchar su RUT completo. Por favor, dígalo nuevamente.',
                'NO_DIGIT_SEQUENCE': 'No pude entender bien. Por favor, dígame su RUT más despacio.',
                'TEXT_WITHOUT_DIGITS': 'Por favor, dígame solo los números de su RUT.',
                'INVALID_RUT_FORMAT': 'El formato no es correcto. Por favor, dígalo nuevamente.',
                'INVALID_RUT_FORMAT_PATTERN': 'El formato no es correcto. Por favor, dígalo nuevamente.'
            };
            
            return messages[errorType] || (attempts >= 2 
                ? 'Para ayudarle mejor, puede usar el teclado para ingresar su RUT.'
                : 'Por favor, dígame su RUT nuevamente.');
        };
        
        const retryMessage = getRetryMessage(errorType, attempts);
        log('debug', `💊 [QUINTERO PHASED] Mensaje de retry sugerido: "${retryMessage}"`);

        // 🎯 MIGRACIÓN A DTMF: Después de 2 intentos inválidos, sugerir DTMF
        if (attempts >= 2) {
            log('info', `💊 [QUINTERO PHASED] ⚠️ ${attempts} intentos inválidos - Considerando migración a DTMF`);
            // TODO: Implementar migración a DTMF cuando esté disponible
            // Por ahora, continuar con re-prompt de voz pero con mensaje más claro
        }

        const nextAudio = (attempts <= 1) ? 'quintero/ask_rut' : 'quintero/ask_rut_retry';

        if (attempts > this.maxRetries) {
            return this.emit(ctx, {
                fn: 'handleProcessRut:maxRetries',
                res: this.transferOrHangup()
            });
        }

        const res = {
            audio: nextAudio,
            nextPhase: 'LISTEN_RUT',
            silent: true,
            skipInput: true,
            allowBargeIn: false,
            action: 'PLAY_AUDIO',
            enableIncremental: true // 🎯 CONTRATO: Reactivar incremental para retry
        };
        this.currentState = 'LISTEN_RUT';
        return this.emit(ctx, {
            fn: 'handleProcessRut:retryPrompt',
            phaseOut: 'PROMPT_RUT',
            res
        });
    }

    // 🟦 FASE 4: CONFIRM_RUT (Confirmación Legacy)
    // Reproduce audio legacy con últimos 4 dígitos + DV y escucha confirmación
    async handleConfirmRut(ctx) {
        const callKey = ctx.linkedId || ctx.sessionId;
        if (!callKey) {
            return this.emit(ctx, {
                fn: 'handleConfirmRut:noCallKey',
                res: this.endCall()
            });
        }

        // Obtener RUT formateado desde Redis
        const rutFormatted = await redis.get(`rut:formatted:${callKey}`);
        if (!rutFormatted) {
            log('warn', `⚠️ [QUINTERO PHASED] No hay RUT formateado en Redis para ${callKey}, volviendo a LISTEN_RUT`);
            this.currentState = 'LISTEN_RUT';
            return this.emit(ctx, {
                fn: 'handleConfirmRut:noRut',
                res: {
                    audio: 'quintero/ask_rut',
                    nextPhase: 'LISTEN_RUT',
                    silent: true,
                    skipInput: true,
                    action: 'PLAY_AUDIO',
                    enableIncremental: true
                }
            });
        }

        const transcript = ctx.transcript || '';
        const event = ctx.event || ctx.eventType || 'TURN';

        // Si es la primera vez (sin transcript), reproducir audio de confirmación
        if (!transcript || transcript.trim().length === 0) {
            if (event === 'NO_INPUT' || event === 'TURN') {
                // 🎯 IMPORTAR función para generar texto de confirmación
                const { getConfirmationReading } = await import('../rut/rut-normalizer.js');
                const confirmationText = getConfirmationReading(rutFormatted);
                
                log('info', `💊 [QUINTERO PHASED] Reproduciendo confirmación de RUT: "${confirmationText}"`);
                
                // 🎯 LEGACY: Usar TTS para confirmación (puede cambiarse a audio fijo después)
                this.currentState = 'CONFIRM_RUT';
                return this.emit(ctx, {
                    fn: 'handleConfirmRut:prompt',
                    res: {
                        action: 'SAY_TEXT',
                        ttsText: confirmationText,
                        nextPhase: 'CONFIRM_RUT',
                        silent: false, // Escuchar respuesta
                        skipUserInput: false,
                        enableIncremental: false // No necesitamos incremental para sí/no
                    }
                });
            }
        }

        // Si hay transcript, clasificar respuesta
        const { classifyConfirm } = await import('../openai/confirm-classifier.js');
        const confirmIntent = classifyConfirm(transcript);
        
        log('info', `💊 [QUINTERO PHASED] Confirmación: intent="${confirmIntent}", transcript="${transcript}"`);

        if (confirmIntent === 'YES') {
            // ✅ RUT confirmado → Avanzar a VALIDATE_PATIENT
            log('info', `✅ [QUINTERO PHASED] RUT confirmado por usuario → Validando paciente`);
            
            // Limpiar RUT de Redis (ya no se necesita)
            await redis.del(`rut:formatted:${callKey}`);
            
            this.currentState = 'VALIDATE_PATIENT';
            return this.emit(ctx, {
                fn: 'handleConfirmRut:confirmed',
                res: {
                    action: {
                        type: 'WEBHOOK',
                        action: 'VALIDATE_PATIENT',
                        rut: rutFormatted
                    },
                    nextPhase: 'VALIDATE_PATIENT',
                    silent: true, // Esperar respuesta del webhook
                    skipUserInput: true,
                    enableIncremental: false
                }
            });
        } else if (confirmIntent === 'NO') {
            // ❌ RUT rechazado → Volver a LISTEN_RUT
            log('info', `❌ [QUINTERO PHASED] RUT rechazado por usuario → Volviendo a LISTEN_RUT`);
            
            // Limpiar RUT de Redis
            await redis.del(`rut:formatted:${callKey}`);
            
            this.currentState = 'LISTEN_RUT';
            return this.emit(ctx, {
                fn: 'handleConfirmRut:rejected',
                res: {
                    audio: 'quintero/ask_rut',
                    nextPhase: 'LISTEN_RUT',
                    silent: true,
                    skipInput: true,
                    action: 'PLAY_AUDIO',
                    enableIncremental: true // Reactivar incremental para nueva captura
                }
            });
        } else {
            // ❓ Respuesta no clara → Repetir confirmación
            log('warn', `❓ [QUINTERO PHASED] Respuesta de confirmación no clara: "${transcript}" → Repitiendo`);
            
            const { getConfirmationReading } = await import('../rut/rut-normalizer.js');
            const confirmationText = getConfirmationReading(rutFormatted);
            
            this.currentState = 'CONFIRM_RUT';
            return this.emit(ctx, {
                fn: 'handleConfirmRut:unclear',
                res: {
                    action: 'SAY_TEXT',
                    ttsText: `${confirmationText} Por favor responda sí o no.`,
                    nextPhase: 'CONFIRM_RUT',
                    silent: false,
                    skipUserInput: false,
                    enableIncremental: false
                }
            });
        }
    }

    // 🟦 FASE 5: VALIDATE_PATIENT (Validar paciente en backend)
    // Maneja la respuesta del webhook VALIDATE_PATIENT
    async handleValidatePatient(ctx) {
        const callKey = ctx.linkedId || ctx.sessionId;
        if (!callKey) {
            return this.emit(ctx, {
                fn: 'handleValidatePatient:noCallKey',
                res: this.endCall()
            });
        }

        const event = ctx.event || ctx.eventType || 'TURN';

        // Si es WEBHOOK_RESPONSE, procesar resultado
        if (event === 'WEBHOOK_RESPONSE' && ctx.webhookData?.action === 'VALIDATE_PATIENT') {
            const { data } = ctx.webhookData;

            if (!data || !data.ok) {
                // Error en webhook o paciente no encontrado
                log('warn', `⚠️ [QUINTERO PHASED] VALIDATE_PATIENT falló: ok=${data?.ok}, reason=${data?.reason || 'unknown'}`);
                
                this.currentState = 'END_CALL';
                return this.emit(ctx, {
                    fn: 'handleValidatePatient:failed',
                    res: {
                        action: 'SAY_TEXT',
                        ttsText: "No fue posible validar sus datos. Por favor, comuníquese con el consultorio.",
                        nextPhase: 'END_CALL',
                        skipUserInput: true,
                        shouldHangup: true
                    }
                });
            }

            if (!data.patientFound) {
                // Paciente NO existe
                log('warn', `⚠️ [QUINTERO PHASED] Paciente no encontrado para RUT`);
                
                this.currentState = 'END_CALL';
                return this.emit(ctx, {
                    fn: 'handleValidatePatient:notFound',
                    res: {
                        action: 'SAY_TEXT',
                        ttsText: "No fue posible validar sus datos. Por favor, comuníquese con el consultorio.",
                        nextPhase: 'END_CALL',
                        skipUserInput: true,
                        shouldHangup: true
                    }
                });
            }

            // ✅ Paciente encontrado → Avanzar a ASK_SPECIALTY
            log('info', `✅ [QUINTERO PHASED] Paciente validado: nombre=${data.nombre || 'N/A'}, edad=${data.edad || 'N/A'}`);
            
            // Guardar datos del paciente en Redis para uso posterior
            await redis.set(`patient:${callKey}`, JSON.stringify({
                rut: data.rut,
                nombre: data.nombre,
                edad: data.edad
            }), { EX: 600 });

            this.currentState = 'ASK_SPECIALTY';
            const nombrePrimero = data.nombre ? data.nombre.split(' ')[0] : '';
            const ttsText = nombrePrimero
                ? `Gracias, señor ${nombrePrimero}. ¿Para qué especialidad médica necesita agendar su hora? Por ejemplo, medicina general, control o alguna especialidad en particular.`
                : "Gracias. ¿Para qué especialidad médica necesita agendar su hora? Por ejemplo, medicina general, control o alguna especialidad en particular.";

            return this.emit(ctx, {
                fn: 'handleValidatePatient:success',
                res: {
                    action: 'SAY_TEXT',
                    ttsText: ttsText,
                    nextPhase: 'ASK_SPECIALTY',
                    silent: false,
                    skipUserInput: false,
                    enableIncremental: false
                }
            });
        }

        // Si no es WEBHOOK_RESPONSE, esperar (el webhook se está ejecutando)
        log('debug', `⏳ [QUINTERO PHASED] Esperando respuesta de webhook VALIDATE_PATIENT`);
        this.currentState = 'VALIDATE_PATIENT';
        return this.emit(ctx, {
            fn: 'handleValidatePatient:waiting',
            res: {
                action: 'SET_STATE',
                nextPhase: 'VALIDATE_PATIENT',
                silent: true, // No escuchar mientras esperamos webhook
                skipUserInput: true,
                enableIncremental: false
            }
        });
    }

    handleWebhookResponse(data) {
        return this.emit(null, {
            fn: 'handleWebhookResponse',
            res: this.endCall()
        });
    }

    transferOrHangup() {
        log('info', `💊 [QUINTERO PHASED] Max attempts (Transfer)`);
        this.currentState = 'END_CALL';
        return {
            audio: 'quintero/transfer_agent',
            nextPhase: 'HANGUP',
            skipUserInput: true,
            shouldHangup: true,
            action: 'PLAY_AUDIO'
        };
    }

    endCall() {
        if (this.currentState === 'END_CALL' && this.farewellPlayed) {
            return { shouldHangup: true, action: 'HANGUP', nextPhase: 'HANGUP', silent: true, skipUserInput: true };
        }
        this.currentState = 'END_CALL';
        this.farewellPlayed = true;
        return {
            audio: 'quintero/farewell',
            ttsText: null,
            nextPhase: 'HANGUP',
            silent: true,
            skipUserInput: true,
            allowBargeIn: false,
            shouldHangup: true,
            action: 'PLAY_AUDIO'
        };
    }
}

export default QuinteroPhasedCapsule;
