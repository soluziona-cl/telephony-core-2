/**
 * 🎯 SEGMENTER - Gestión de segmentos de audio por fase usando sistema de marcas
 * 
 * Responsabilidades:
 * - Abrir/cerrar ventana por fase
 * - Registrar marcas (DELTA, VAD, SILENCE, COMMIT, MANUAL)
 * - Convertir marcas en segmentos con pre/post roll
 * - Encolar STT batch
 */

import { log } from "../../../lib/logger.js";

export class Segmenter {
    constructor({
        callId,
        logger,
        store,
        enqueueStt,
        preRollMs = 250,
        postRollMs = 350,
        silenceStableMs = 550,
        maxSegmentMs = 12000
    }) {
        this.callId = callId;
        this.log = logger || log;
        this.store = store;           // Redis store (o memoria)
        this.enqueueStt = enqueueStt; // sttQueue.enqueue(segment)

        this.preRollMs = preRollMs;
        this.postRollMs = postRollMs;
        this.silenceStableMs = silenceStableMs;
        this.maxSegmentMs = maxSegmentMs;

        this._startedAtEpochMs = null;
        this._phase = null;
        this._windowOpen = false;

        this._state = "idle";     // idle | in_talk | cooldown
        this._talkStartMs = null;
        this._lastTalkEndMs = null;
        this._cooldownTimer = null;

        this._segSeq = 0;
        this._markSeq = 0;
        this._marks = [];
    }

    /**
     * Llamar cuando se confirma RecordingStarted (o inmediatamente tras start)
     * @param {number} startedAtEpochMs - Timestamp epoch en milisegundos
     */
    setStartedAt(startedAtEpochMs) {
        this._startedAtEpochMs = startedAtEpochMs;
        this.log.info(`[SEG] t0 seteado: ${startedAtEpochMs}`);
    }

    /**
     * Obtener offset en milisegundos desde el inicio de la grabación
     * @returns {number}
     */
    nowMs() {
        if (!this._startedAtEpochMs) return 0;
        const raw = Date.now() - this._startedAtEpochMs;
        // Compensación opcional por latencia del recorder
        const latencyMs = parseInt(process.env.RECORDER_LATENCY_MS || "0", 10);
        return Math.max(0, raw - latencyMs);
    }

    /**
     * Abrir ventana de segmentación para una fase
     * @param {string} phase - Nombre de la fase (ej: LISTEN_RUT)
     */
    openWindow(phase) {
        this._phase = phase;
        this._windowOpen = true;
        const t = this.nowMs();
        this.log.info(`[SEG] window OPEN phase=${phase} t=${t}ms`);
        
        // Marca de inicio de ventana
        this.addMark({
            type: "WINDOW_OPEN",
            offsetMs: t,
            meta: { phase }
        });
    }

    /**
     * Cerrar ventana de segmentación
     */
    closeWindow() {
        if (!this._windowOpen) return;
        
        const t = this.nowMs();
        this.log.info(`[SEG] window CLOSE phase=${this._phase} t=${t}ms`);
        
        // Forzar flush de cualquier segmento pendiente
        if (this._state === "in_talk" || this._talkStartMs) {
            this.forceFlush("window_closed");
        }
        
        // Marca de cierre de ventana
        this.addMark({
            type: "WINDOW_CLOSE",
            offsetMs: t,
            meta: { phase: this._phase }
        });
        
        this._windowOpen = false;
        this._phase = null;
    }

    /**
     * Agregar marca (DELTA, VAD, SILENCE, COMMIT, MANUAL)
     * @param {Object} mark
     * @param {string} mark.type - Tipo de marca
     * @param {number} mark.offsetMs - Offset en milisegundos
     * @param {Object} mark.meta - Metadata adicional
     * @returns {Object} - Marca creada
     */
    addMark({ type, offsetMs, meta = {} }) {
        const id = ++this._markSeq;
        const atEpochMs = this._startedAtEpochMs ? this._startedAtEpochMs + offsetMs : Date.now();
        
        const mark = {
            id,
            type,
            offsetMs,
            atEpochMs,
            meta
        };
        
        this._marks.push(mark);
        
        // Persistir en Redis (async, no bloquea)
        if (this.store) {
            this.store.appendMark(this.callId, mark).catch(err => {
                this.log.warn(`[SEG] Error guardando marca: ${err.message}`);
            });
        }
        
        this.log.debug(`[SEG] MARK_ADDED id=${id} type=${type} offset=${offsetMs}ms`);
        
        return mark;
    }

    /**
     * Handler de inicio de habla (desde eventos talking)
     */
    onTalkingStart() {
        if (!this._windowOpen) return;

        const t = this.nowMs();
        if (this._state === "in_talk") return;

        this._state = "in_talk";
        this._talkStartMs = t;
        this._lastTalkEndMs = null;

        if (this._cooldownTimer) {
            clearTimeout(this._cooldownTimer);
            this._cooldownTimer = null;
        }

        this.log.debug(`[SEG] TALK_START t=${t} phase=${this._phase}`);
        
        // Marca de inicio de habla
        this.addMark({
            type: "TALK_START",
            offsetMs: t,
            meta: { phase: this._phase }
        });
    }

    /**
     * Handler de fin de habla (desde eventos talking)
     */
    onTalkingStop() {
        if (!this._windowOpen) return;
        const t = this.nowMs();
        if (this._state !== "in_talk") return;

        this._state = "cooldown";
        this._lastTalkEndMs = t;
        this.log.debug(`[SEG] TALK_END t=${t} phase=${this._phase}`);

        // Marca de fin de habla
        this.addMark({
            type: "TALK_END",
            offsetMs: t,
            meta: { phase: this._phase }
        });

        // Espera silencio estable
        if (this._cooldownTimer) clearTimeout(this._cooldownTimer);
        this._cooldownTimer = setTimeout(() => {
            this._finalizeSegment("talk_end_silence_stable");
        }, this.silenceStableMs);
    }

    /**
     * Agregar marca de delta (texto parcial del STT incremental)
     * @param {string} deltaText - Texto del delta
     * @param {Object} meta - Metadata adicional
     */
    onDelta(deltaText, meta = {}) {
        if (!this._windowOpen) return;
        
        const t = this.nowMs();
        this.addMark({
            type: "DELTA",
            offsetMs: t,
            meta: { deltaText, ...meta }
        });
    }

    /**
     * Agregar marca de commit (cuando VAD/silencio detecta que debe cortar)
     * @param {string} reason - Razón del commit
     */
    onCommit(reason = "vad_silence") {
        if (!this._windowOpen) return;
        
        const t = this.nowMs();
        const mark = this.addMark({
            type: "COMMIT",
            offsetMs: t,
            meta: { reason }
        });
        
        // Programar creación de segmento
        this.scheduleCommit(mark.id);
    }

    /**
     * Programar commit de segmento (con debounce)
     * @param {number} markId - ID de la marca COMMIT
     */
    scheduleCommit(markId) {
        // Debounce: no hacer múltiples commits seguidos
        if (this._cooldownTimer) {
            clearTimeout(this._cooldownTimer);
        }
        
        this._cooldownTimer = setTimeout(() => {
            this._finalizeSegment("commit", null, markId);
        }, 100); // Pequeño debounce para agrupar commits cercanos
    }

    /**
     * Forzar flush de segmento pendiente
     * @param {string} reason - Razón del flush (ej: domain_accept, window_closed)
     */
    forceFlush(reason = "domain_accept") {
        if (!this._windowOpen) return;
        
        // Si estaba hablando, toma end=now. Si no, usa lastTalkEnd.
        const endMs = this.nowMs();
        this.log.info(`[SEG] FORCE_FLUSH reason=${reason} endMs=${endMs} phase=${this._phase}`);
        this._finalizeSegment(reason, endMs);
    }

    /**
     * Finalizar segmento y encolarlo para STT
     * @param {string} reason - Razón de finalización
     * @param {number|null} forcedEndMs - Fin forzado (si es null, usa lastTalkEnd)
     * @param {number|null} commitMarkId - ID de la marca COMMIT que disparó esto
     */
    _finalizeSegment(reason, forcedEndMs = null, commitMarkId = null) {
        if (!this._windowOpen) return;

        const endMs = forcedEndMs ?? this._lastTalkEndMs ?? this.nowMs();
        const startMs = this._talkStartMs;

        // Sanity check
        if (startMs == null) {
            this._reset();
            return;
        }

        let segStart = Math.max(0, startMs - this.preRollMs);
        let segEnd = endMs + this.postRollMs;

        // Recortar a maxSegment si se fue largo
        if (segEnd - segStart > this.maxSegmentMs) {
            segEnd = segStart + this.maxSegmentMs;
        }

        const duration = segEnd - segStart;
        if (duration < 300) {
            this.log.warn(`[SEG] DROP too_short duration=${duration}ms phase=${this._phase}`);
            this._reset();
            return;
        }

        const segId = `seg_${String(++this._segSeq).padStart(4, "0")}`;
        const segment = {
            callId: this.callId,
            segId,
            phase: this._phase,
            startMs: segStart,
            endMs: segEnd,
            preRollMs: this.preRollMs,
            postRollMs: this.postRollMs,
            reason,
            commitMarkId,
            stt: { status: "pending" },
            createdAtMs: this.nowMs(),
        };

        // Guardar en store
        if (this.store) {
            this.store.appendSegment(this.callId, segment).catch(err => {
                this.log.warn(`[SEG] Error guardando segmento: ${err.message}`);
            });
        }

        // Encolar para STT
        this.enqueueStt(segment);

        this.log.info(`[SEG] SEGMENT_CREATED id=${segId} phase=${segment.phase} start=${segment.startMs} end=${segment.endMs} reason=${reason}`);

        this._reset();
    }

    /**
     * Resetear estado interno
     */
    _reset() {
        this._state = "idle";
        this._talkStartMs = null;
        this._lastTalkEndMs = null;
        if (this._cooldownTimer) {
            clearTimeout(this._cooldownTimer);
            this._cooldownTimer = null;
        }
    }

    /**
     * Limpiar recursos
     */
    async cleanup() {
        // Forzar flush de segmento pendiente
        if (this._windowOpen && (this._state === "in_talk" || this._talkStartMs)) {
            this.forceFlush("cleanup");
        }
        
        // Cerrar ventana si está abierta
        if (this._windowOpen) {
            this.closeWindow();
        }
        
        // Cancelar timers
        if (this._cooldownTimer) {
            clearTimeout(this._cooldownTimer);
            this._cooldownTimer = null;
        }
        
        this.log.info(`[SEG] Cleanup completado para ${this.callId}`);
    }
}
