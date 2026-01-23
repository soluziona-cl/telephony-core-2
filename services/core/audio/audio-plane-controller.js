import { log } from "../../../lib/logger.js";

/**
 * AUDIO PLANE CONTROLLER
 * 
 * Responsable de garantizar la integridad del plano de audio FÍSICO (RTP/Canales).
 * Actúa como la "Fuente de Verdad Física" por encima de los eventos de señalización.
 * 
 * Resuelve:
 * 1. Ghost Channels (Snoops que Stasis reporta pero ARI REST no encuentra).
 * 2. Ephemeral Races (Snoops destruidos por GC antes de anclarse).
 * 3. Atomic Gates (STT no inicia si el audio no es físico).
 */

export const AudioPlaneController = {

    /**
     * Espera activamente a que un canal exista físicamente en el plano de audio (ARI REST).
     * @param {Object} ari - Cliente ARI
     * @param {string} channelId - ID del canal a verificar
     * @param {number} timeoutMs - Tiempo máximo de espera (default 2000ms)
     * @returns {Promise<boolean>} true si el canal está UP, false si timeout/error
     */
    async waitForAudioPlaneReady(ari, channelId, timeoutMs = 2000) {
        const start = Date.now();
        const interval = 50;
        let attempt = 0;

        while (Date.now() - start < timeoutMs) {
            attempt++;
            try {
                const channel = await ari.channels.get({ channelId });
                if (channel && channel.state === 'Up') {
                    // 🎯 ÉXITO: Canal físico confirmado y activo
                    if (attempt > 1) {
                        log("debug", `✅ [AUDIO_PLANE] Canal ${channelId} materializado tras ${attempt} intentos (${Date.now() - start}ms)`);
                    }
                    return true;
                }
            } catch (ignore) {
                // Ignorar 404s mientras esperamos materialización
            }
            await new Promise(r => setTimeout(r, interval));
        }

        log("warn", `⚠️ [AUDIO_PLANE] Timeout esperando canal físico ${channelId} tras ${timeoutMs}ms`);
        return false;
    },

    /**
     * Intenta anclar (PIN) un canal a un bridge de forma agresiva (Loop-Retry).
     * Esto es crítico para evitar que Asterisk elimine canales Snoop huérfanos.
     * 
     * @param {Object} bridge - Objeto Bridge de ARI
     * @param {string} channelId - ID del canal a anclar
     * @param {number} maxRetries - Intentos máximos (default 5)
     * @returns {Promise<boolean>} true si se ancló, false si falló todo
     */
    async pinSnoopToBridge(bridge, channelId, maxRetries = 5) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await bridge.addChannel({ channel: channelId });
                // 🎯 ÉXITO: Anclaje confirmado
                log("info", `📌 [AUDIO_PLANE] Canal ${channelId} anclado (PIN) al bridge ${bridge.id} (Intento ${i + 1}/${maxRetries})`);
                return true;
            } catch (err) {
                // Si es 404 o 400, puede ser lag de ARI o race condition
                const isRetryable = err.message && (err.message.includes('not found') || err.message.includes('400') || err.message.includes('404'));

                if (isRetryable) {
                    if (i < maxRetries - 1) {
                        await new Promise(r => setTimeout(r, 100)); // Esperar 100ms antes de reintentar
                        continue;
                    }
                }

                log("warn", `⚠️ [AUDIO_PLANE] Falló PIN de ${channelId} en puente ${bridge.id}: ${err.message}`);
                // No re-throw, intentar siguiente o salir false
            }
        }
        return false;
    },

    /**
     * Verificación instantánea (One-Shot) del estado físico.
     * Usar en EnsureSTT para validación final.
     */
    async checkPhysical(ari, channelId) {
        try {
            const channel = await ari.channels.get({ channelId });
            return channel && channel.state === 'Up';
        } catch (e) {
            return false;
        }
    }
};
