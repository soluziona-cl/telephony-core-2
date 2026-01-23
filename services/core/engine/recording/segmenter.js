/**
 * 🎯 SEGMENTER - Gestión de segmentos de audio por fase
 * 
 * Responsabilidades:
 * - Abrir/cerrar ventana por fase
 * - Escuchar ChannelTalkingStarted/Finished del snoop
 * - Crear segmentos con pre/post roll
 * - Encolar STT batch
 */

import { log } from '../../../../lib/logger.js';
import redis from '../../../../lib/redis.js';

// ⚙️ Configuración de segmentación
const PRE_ROLL_MS = parseInt(process.env.SEGMENT_PRE_ROLL_MS || '250', 10);
const POST_ROLL_MS = parseInt(process.env.SEGMENT_POST_ROLL_MS || '350', 10);
const SILENCE_STABLE_MS = parseInt(process.env.SEGMENT_SILENCE_STABLE_MS || '550', 10);
const MAX_SEGMENT_MS = parseInt(process.env.SEGMENT_MAX_MS || '7000', 10);
const MIN_SEGMENT_MS = parseInt(process.env.SEGMENT_MIN_MS || '300', 10);

/**
 * Estado interno del segmenter por llamada
 */
class SegmenterState {
    constructor(callId, recordingInfo) {
        this.callId = callId;
        this.recording = recordingInfo;
        this.phase = {
            name: null,
            windowOpen: false,
            windowStartMs: null,
            windowCloseMs: null
        };
        this.segmenter = {
            state: 'idle', // idle | in_talk | cooldown
            talkStartMs: null,
            lastTalkEndMs: null,
            pendingMarks: [],
            silenceTimer: null
        };
        this.segmentCounter = 0;
    }

    /**
     * Obtener timestamp relativo al inicio de grabación (monotónico)
     */
    getRelativeTimeMs() {
        if (!this.recording.t0HrtimeNs) {
            log('warn', `⚠️ [SEGMENTER] t0HrtimeNs no disponible para ${this.callId}`);
            return Date.now() - this.recording.t0EpochMs;
        }
        const nowNs = process.hrtime.bigint();
        const elapsedNs = nowNs - this.recording.t0HrtimeNs;
        return Number(elapsedNs / 1000000n);
    }
}

/**
 * Segmenter principal
 */
export class Segmenter {
    constructor(ari, callId, linkedId) {
        this.ari = ari;
        this.callId = callId;
        this.linkedId = linkedId;
        this.state = null;
        this.snoopChannelId = null;
        this.talkingHandlers = new Map(); // channelId -> { start, end }
    }

    /**
     * Inicializar segmenter con información de grabación
     * @param {Object} recordingInfo - { name, path, t0HrtimeNs, t0EpochMs }
     */
    async init(recordingInfo) {
        const t0HrtimeNs = process.hrtime.bigint();
        const t0EpochMs = Date.now();

        const fullRecordingInfo = {
            ...recordingInfo,
            t0HrtimeNs,
            t0EpochMs
        };

        this.state = new SegmenterState(this.callId, fullRecordingInfo);

        // Guardar en Redis
        const recKey = `call:${this.callId}:rec`;
        await redis.set(recKey, JSON.stringify({
            callId: this.callId,
            linkedId: this.linkedId,
            recordingName: recordingInfo.name,
            recordingPath: recordingInfo.path,
            t0MonoMs: 0,
            t0EpochMs,
            status: 'recording',
            createdAt: new Date().toISOString()
        }), { EX: 3600 });

        log('info', `✅ [SEGMENTER] Inicializado para ${this.callId}`, {
            recordingName: recordingInfo.name,
            t0EpochMs
        });
    }

    /**
     * Configurar canal Snoop para escuchar eventos talking
     * @param {string} snoopChannelId - ID del canal Snoop
     */
    setSnoopChannel(snoopChannelId) {
        this.snoopChannelId = snoopChannelId;
        this._setupTalkingListeners(snoopChannelId);
        log('info', `🎧 [SEGMENTER] Snoop configurado: ${snoopChannelId}`);
    }

    /**
     * Configurar listeners de eventos talking en el Snoop
     */
    _setupTalkingListeners(snoopChannelId) {
        if (this.talkingHandlers.has(snoopChannelId)) {
            log('warn', `⚠️ [SEGMENTER] Listeners ya configurados para ${snoopChannelId}`);
            return;
        }

        const handlers = {
            start: async (event, channel) => {
                if (channel.id !== snoopChannelId) return;
                await this.onTalkingStart();
            },
            end: async (event, channel) => {
                if (channel.id !== snoopChannelId) return;
                await this.onTalkingStop();
            }
        };

        this.ari.on('ChannelTalkingStarted', handlers.start);
        this.ari.on('ChannelTalkingFinished', handlers.end);

        this.talkingHandlers.set(snoopChannelId, handlers);

        log('info', `👂 [SEGMENTER] Listeners de talking configurados para ${snoopChannelId}`);
    }

    /**
     * Abrir ventana de segmentación para una fase
     * @param {string} phaseName - Nombre de la fase (ej: LISTEN_RUT)
     */
    async openWindow(phaseName) {
        if (!this.state) {
            log('error', `❌ [SEGMENTER] No inicializado - no se puede abrir ventana`);
            return;
        }

        const nowMs = this.state.getRelativeTimeMs();

        this.state.phase.name = phaseName;
        this.state.phase.windowOpen = true;
        this.state.phase.windowStartMs = nowMs;

        // Guardar en Redis
        const phaseKey = `call:${this.callId}:phase`;
        await redis.set(phaseKey, JSON.stringify({
            name: phaseName,
            windowOpen: true,
            openedAtMs: nowMs,
            closedAtMs: null
        }), { EX: 3600 });

        log('info', `🪟 [SEGMENTER] Ventana abierta: ${phaseName} (t=${nowMs}ms)`);
    }

    /**
     * Cerrar ventana de segmentación
     */
    async closeWindow() {
        if (!this.state || !this.state.phase.windowOpen) {
            return;
        }

        const nowMs = this.state.getRelativeTimeMs();
        this.state.phase.windowOpen = false;
        this.state.phase.windowCloseMs = nowMs;

        // Actualizar Redis
        const phaseKey = `call:${this.callId}:phase`;
        const phaseData = await redis.get(phaseKey);
        if (phaseData) {
            const phase = JSON.parse(phaseData);
            phase.windowOpen = false;
            phase.closedAtMs = nowMs;
            await redis.set(phaseKey, JSON.stringify(phase), { EX: 3600 });
        }

        // Forzar flush de cualquier segmento pendiente
        if (this.state.segmenter.state === 'in_talk' || this.state.segmenter.talkStartMs) {
            await this.forceFlush('window_closed');
        }

        log('info', `🪟 [SEGMENTER] Ventana cerrada: ${this.state.phase.name} (t=${nowMs}ms)`);
    }

    /**
     * Handler de inicio de habla
     */
    async onTalkingStart() {
        if (!this.state || !this.state.phase.windowOpen) {
            return; // Ventana cerrada, ignorar
        }

        const nowMs = this.state.getRelativeTimeMs();

        // Si ya estamos en talk, ignorar (puede ser evento duplicado)
        if (this.state.segmenter.state === 'in_talk') {
            log('debug', `🔄 [SEGMENTER] TalkingStart recibido pero ya en talk (t=${nowMs}ms)`);
            return;
        }

        // Cancelar timer de silencio si existe
        if (this.state.segmenter.silenceTimer) {
            clearTimeout(this.state.segmenter.silenceTimer);
            this.state.segmenter.silenceTimer = null;
        }

        this.state.segmenter.state = 'in_talk';
        this.state.segmenter.talkStartMs = nowMs;

        log('info', `🗣️ [SEGMENTER] TalkingStart (t=${nowMs}ms, phase=${this.state.phase.name})`);
    }

    /**
     * Handler de fin de habla
     */
    async onTalkingStop() {
        if (!this.state || !this.state.phase.windowOpen) {
            return; // Ventana cerrada, ignorar
        }

        if (this.state.segmenter.state !== 'in_talk') {
            return; // No estábamos en talk, ignorar
        }

        const nowMs = this.state.getRelativeTimeMs();
        this.state.segmenter.lastTalkEndMs = nowMs;
        this.state.segmenter.state = 'cooldown';

        log('info', `🔇 [SEGMENTER] TalkingStop (t=${nowMs}ms, phase=${this.state.phase.name})`);

        // Iniciar timer de silencio estable
        this.state.segmenter.silenceTimer = setTimeout(async () => {
            await this._detectSilenceStable();
        }, SILENCE_STABLE_MS);
    }

    /**
     * Detectar silencio estable y crear segmento
     */
    async _detectSilenceStable() {
        if (!this.state || !this.state.phase.windowOpen) {
            return;
        }

        if (this.state.segmenter.state !== 'cooldown') {
            return; // Ya cambió de estado
        }

        const { talkStartMs, lastTalkEndMs } = this.state.segmenter;

        if (!talkStartMs || !lastTalkEndMs) {
            log('warn', `⚠️ [SEGMENTER] Silencio estable detectado pero falta talkStartMs o lastTalkEndMs`);
            return;
        }

        // Validar duración mínima
        const duration = lastTalkEndMs - talkStartMs;
        if (duration < MIN_SEGMENT_MS) {
            log('debug', `⏭️ [SEGMENTER] Segmento muy corto (${duration}ms < ${MIN_SEGMENT_MS}ms) - descartando`);
            this.state.segmenter.state = 'idle';
            this.state.segmenter.talkStartMs = null;
            this.state.segmenter.lastTalkEndMs = null;
            return;
        }

        // Crear segmento
        await this._createSegment(talkStartMs, lastTalkEndMs, 'talk_end_silence_stable');

        // Resetear estado
        this.state.segmenter.state = 'idle';
        this.state.segmenter.talkStartMs = null;
        this.state.segmenter.lastTalkEndMs = null;
    }

    /**
     * Forzar flush de segmento pendiente
     * @param {string} reason - Razón del flush (ej: domain_accept, window_closed, timeout)
     */
    async forceFlush(reason = 'manual') {
        if (!this.state) {
            return;
        }

        const { talkStartMs, lastTalkEndMs } = this.state.segmenter;

        if (!talkStartMs) {
            log('debug', `⏭️ [SEGMENTER] ForceFlush sin talkStartMs (reason=${reason})`);
            return;
        }

        const endMs = lastTalkEndMs || this.state.getRelativeTimeMs();

        // Validar duración mínima
        const duration = endMs - talkStartMs;
        if (duration < MIN_SEGMENT_MS) {
            log('debug', `⏭️ [SEGMENTER] ForceFlush: segmento muy corto (${duration}ms) - descartando`);
            this.state.segmenter.state = 'idle';
            this.state.segmenter.talkStartMs = null;
            this.state.segmenter.lastTalkEndMs = null;
            return;
        }

        await this._createSegment(talkStartMs, endMs, reason);

        // Resetear estado
        this.state.segmenter.state = 'idle';
        this.state.segmenter.talkStartMs = null;
        this.state.segmenter.lastTalkEndMs = null;

        // Cancelar timer de silencio si existe
        if (this.state.segmenter.silenceTimer) {
            clearTimeout(this.state.segmenter.silenceTimer);
            this.state.segmenter.silenceTimer = null;
        }
    }

    /**
     * Crear segmento y encolar para STT
     */
    async _createSegment(startMs, endMs, reason) {
        if (endMs <= startMs) {
            log('error', `❌ [SEGMENTER] Segmento inválido: endMs (${endMs}) <= startMs (${startMs})`);
            return;
        }

        // Aplicar pre/post roll
        const segmentStartMs = Math.max(0, startMs - PRE_ROLL_MS);
        const segmentEndMs = endMs + POST_ROLL_MS;

        // Validar duración máxima
        const duration = segmentEndMs - segmentStartMs;
        if (duration > MAX_SEGMENT_MS) {
            log('warn', `⚠️ [SEGMENTER] Segmento excede MAX_SEGMENT_MS (${duration}ms > ${MAX_SEGMENT_MS}ms) - truncando`);
            // Truncar desde el inicio
            const truncatedStart = segmentEndMs - MAX_SEGMENT_MS;
            segmentStartMs = Math.max(0, truncatedStart);
        }

        this.state.segmentCounter++;
        const segId = `seg_${String(this.state.segmentCounter).padStart(4, '0')}`;

        const segment = {
            segId,
            phase: this.state.phase.name,
            startMs: segmentStartMs,
            endMs: segmentEndMs,
            preRollMs: PRE_ROLL_MS,
            postRollMs: POST_ROLL_MS,
            reason,
            stt: { status: 'pending' },
            createdAt: new Date().toISOString()
        };

        // Guardar en Redis (lista de segmentos)
        const segmentsKey = `call:${this.callId}:segments`;
        await redis.lPush(segmentsKey, JSON.stringify(segment));
        await redis.expire(segmentsKey, 3600);

        log('info', `📦 [SEGMENTER] Segmento creado: ${segId}`, {
            phase: segment.phase,
            startMs: segment.startMs,
            endMs: segment.endMs,
            duration: segment.endMs - segment.startMs,
            reason
        });

        // Encolar para STT batch
        await this._enqueueSTT(segment);
    }

    /**
     * Encolar segmento para procesamiento STT batch
     */
    async _enqueueSTT(segment) {
        const queueKey = `stt:batch:queue`;
        const queueItem = {
            callId: this.callId,
            linkedId: this.linkedId,
            segment,
            recordingName: this.state.recording.name,
            recordingPath: this.state.recording.path,
            queuedAt: new Date().toISOString()
        };

        await redis.lPush(queueKey, JSON.stringify(queueItem));
        await redis.publish('stt:batch:new', JSON.stringify({ callId: this.callId, segId: segment.segId }));

        log('info', `📥 [SEGMENTER] Segmento encolado para STT: ${segment.segId}`);
    }

    /**
     * Limpiar recursos y listeners
     */
    async cleanup() {
        // Remover listeners
        if (this.snoopChannelId && this.talkingHandlers.has(this.snoopChannelId)) {
            const handlers = this.talkingHandlers.get(this.snoopChannelId);
            this.ari.removeListener('ChannelTalkingStarted', handlers.start);
            this.ari.removeListener('ChannelTalkingFinished', handlers.end);
            this.talkingHandlers.delete(this.snoopChannelId);
        }

        // Cancelar timers
        if (this.state && this.state.segmenter.silenceTimer) {
            clearTimeout(this.state.segmenter.silenceTimer);
        }

        // Forzar flush de segmento pendiente
        if (this.state && this.state.phase.windowOpen) {
            await this.forceFlush('cleanup');
        }

        log('info', `🧹 [SEGMENTER] Cleanup completado para ${this.callId}`);
    }
}
