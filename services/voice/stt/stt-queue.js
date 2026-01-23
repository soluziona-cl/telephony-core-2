/**
 * 📥 STT QUEUE - Cola de procesamiento de segmentos para STT batch
 */

import { log } from "../../../lib/logger.js";

export class SttQueue {
    constructor({ logger }) {
        this.log = logger || log;
        this.q = [];
        this.running = false;
        this._loopPromise = null;
    }

    /**
     * Encolar trabajo de STT
     * @param {Object} job - Trabajo de segmento para procesar
     */
    enqueue(job) {
        this.q.push(job);
        this.log.debug(`[STT_QUEUE] Job encolado: ${job.segId} (cola: ${this.q.length})`);
    }

    /**
     * Iniciar procesador de cola
     * @param {Function} workerFn - Función que procesa cada trabajo
     */
    start(workerFn) {
        if (this.running) {
            this.log.warn(`[STT_QUEUE] Procesador ya está corriendo`);
            return;
        }
        
        this.running = true;
        this.log.info(`[STT_QUEUE] Procesador iniciado`);

        const loop = async () => {
            while (this.running) {
                const job = this.q.shift();
                if (!job) {
                    await new Promise(r => setTimeout(r, 50));
                    continue;
                }
                
                try {
                    await workerFn(job);
                } catch (e) {
                    this.log.error(`[STT_QUEUE] job failed segId=${job.segId} err=${e?.message}`, {
                        error: e.message,
                        stack: e.stack
                    });
                }
            }
        };

        this._loopPromise = loop();
    }

    /**
     * Detener procesador de cola
     */
    async stop() {
        this.running = false;
        if (this._loopPromise) {
            await this._loopPromise;
        }
        this.log.info(`[STT_QUEUE] Procesador detenido`);
    }

    /**
     * Obtener tamaño de la cola
     * @returns {number}
     */
    size() {
        return this.q.length;
    }
}
