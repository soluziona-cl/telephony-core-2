// services/client/quintero/bot/memory/redisRutMemory.js
import redis from "../../../../../lib/redis.js"; // Adjust based on location: client/quintero/bot/memory -> ../../../../../lib/redis.js

const DEFAULT_TTL_SECONDS = 30;

export function makeRutKey(callKey) {
    return `voicebot:quintero:${callKey}:rut`;
}

/**
 * @param {string} callKey - linkedId o channelId
 * @param {number} ttlSeconds - TTL for keys
 */
export function createRedisRutMemory(callKey, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const base = makeRutKey(callKey);

    const k = {
        buffer: `${base}:buffer`,
        lastSpeechTs: `${base}:lastSpeechTs`,
        enteredListenTs: `${base}:enteredListenTs`,
        attempts: `${base}:attempts`,
    };

    async function touchTTL() {
        // Mantén todo vivo como "memoria volátil"
        await Promise.all([
            redis.expire(k.buffer, ttlSeconds),
            redis.expire(k.lastSpeechTs, ttlSeconds),
            redis.expire(k.enteredListenTs, ttlSeconds),
            redis.expire(k.attempts, ttlSeconds),
        ]);
    }

    return {
        keys: k,

        async initListenWindow(nowMs) {
            // Reset buffer al entrar a LISTEN_RUT
            await redis.set(k.buffer, '');
            await redis.set(k.lastSpeechTs, '0');
            await redis.set(k.enteredListenTs, String(nowMs));

            // attempts se mantiene si existe (no lo resetees aquí)
            const exists = await redis.exists(k.attempts);
            if (!exists) await redis.set(k.attempts, '0');

            // 🎯 MEJORA: Limpiar flag de webhook enviado al reiniciar LISTEN_RUT
            // Esto permite que el webhook se llame nuevamente en un nuevo intento
            // Usar callKey directamente (está en el closure de createRedisRutMemory)
            await redis.del(`rut:webhook:sent:${callKey}`);
            await redis.del(`rut:validated:${callKey}`);

            await touchTTL();
        },

        async appendText(text, nowMs) {
            const clean = String(text || '').trim();
            if (!clean) return;

            // Acumula texto incremental
            await redis.append(k.buffer, ` ${clean}`);
            await redis.set(k.lastSpeechTs, String(nowMs));
            await touchTTL();
        },

        async getSnapshot() {
            const [buffer, lastSpeechTs, enteredListenTs, attempts] = await Promise.all([
                redis.get(k.buffer),
                redis.get(k.lastSpeechTs),
                redis.get(k.enteredListenTs),
                redis.get(k.attempts),
            ]);

            return {
                buffer: (buffer || '').trim(),
                lastSpeechTs: Number(lastSpeechTs || 0),
                enteredListenTs: Number(enteredListenTs || 0),
                attempts: Number(attempts || 0),
            };
        },

        async incAttempts() {
            const n = await redis.incr(k.attempts);
            await touchTTL();
            return Number(n || 0);
        },

        async resetBuffer() {
            await redis.set(k.buffer, '');
            await redis.set(k.lastSpeechTs, '0');
            await touchTTL();
        },

        async destroy() {
            await redis.del(k.buffer, k.lastSpeechTs, k.enteredListenTs, k.attempts);
        },
    };
}
