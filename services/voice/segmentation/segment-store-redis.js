/**
 * 📦 SEGMENT STORE REDIS - Persistencia de marcas y segmentos en Redis
 */

import { log } from "../../../lib/logger.js";

import redis from "../../../lib/redis.js";

export class SegmentStoreRedis {
    constructor({ redis: redisClient = null }) {
        this.redis = redisClient || redis;
    }

    /**
     * Obtener clave Redis para segmentos
     */
    keySegments(callId) {
        return `call:${callId}:segments`;
    }

    /**
     * Obtener clave Redis para metadata de grabación
     */
    keyRec(callId) {
        return `call:${callId}:rec`;
    }

    /**
     * Obtener clave Redis para marcas
     */
    keyMarks(callId) {
        return `call:${callId}:marks`;
    }

    /**
     * Guardar metadata de grabación
     * @param {string} callId
     * @param {Object} meta - Metadata de la grabación
     */
    async setRecMeta(callId, meta) {
        await this.redis.set(this.keyRec(callId), JSON.stringify(meta), { EX: 60 * 60 * 24 });
        log("debug", `💾 [STORE] Metadata de grabación guardada para ${callId}`);
    }

    /**
     * Obtener metadata de grabación
     * @param {string} callId
     * @returns {Promise<Object|null>}
     */
    async getRecMeta(callId) {
        const raw = await this.redis.get(this.keyRec(callId));
        return raw ? JSON.parse(raw) : null;
    }

    /**
     * Agregar marca a la lista
     * @param {string} callId
     * @param {Object} mark - Objeto marca
     */
    async appendMark(callId, mark) {
        await this.redis.rPush(this.keyMarks(callId), JSON.stringify(mark));
        await this.redis.expire(this.keyMarks(callId), 60 * 60 * 24);
        log("debug", `💾 [STORE] Marca guardada: ${mark.type} @ ${mark.offsetMs}ms`);
    }

    /**
     * Agregar segmento a la lista
     * @param {string} callId
     * @param {Object} segment - Objeto segmento
     */
    async appendSegment(callId, segment) {
        await this.redis.rPush(this.keySegments(callId), JSON.stringify(segment));
        await this.redis.expire(this.keySegments(callId), 60 * 60 * 24);
        log("info", `💾 [STORE] Segmento guardado: ${segment.segId} (${segment.startMs}-${segment.endMs}ms)`);
    }

    /**
     * Obtener todos los segmentos
     * @param {string} callId
     * @returns {Promise<Array>}
     */
    async getSegments(callId) {
        const raw = await this.redis.lRange(this.keySegments(callId), 0, -1);
        return raw.map(s => JSON.parse(s));
    }

    /**
     * Obtener todas las marcas
     * @param {string} callId
     * @returns {Promise<Array>}
     */
    async getMarks(callId) {
        const raw = await this.redis.lRange(this.keyMarks(callId), 0, -1);
        return raw.map(m => JSON.parse(m));
    }
}
