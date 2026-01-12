import { log } from '../../lib/logger.js';

/**
 * 🔐 Client Entry Router
 * Centralizes routing logic to enforce Client Capsule architecture.
 * Replaces the legacy domain/bot based routing.
 */

// Helper to load legacy router if needed
async function getLegacyRouter() {
    try {
        // Import legacy router from the frozen directory
        return (await import('../voicebot_legacy/router/voicebot-domain-router.js'));
    } catch (e) {
        log('warn', `⚠️ [ROUTER] Legacy router not found or unreachable.`);
        return null;
    }
}

/**
 * Resolves the appropriate Client Capsule (or Legacy Domain) for a given call mode.
 * @param {string} mode - The call mode (e.g., 'voicebot_identity_quintero')
 * @returns {Promise<Function|null>} - The domain logic function (engine adapter) or null.
 */
export async function resolveClientCapsule(mode) {
    if (!mode) return null;

    // Normalize mode check
    const modeLower = mode.toLowerCase();
    const parts = modeLower.split('_');

    // 1. 🚀 Try Migrated Client Capsules (Priority)
    let clientPath = null;
    let clientName = null;

    if (parts.includes('quintero')) {
        clientPath = '../client/quintero/inbound/engine-adapter.js';
        clientName = 'Quintero';
    } else if (parts.includes('tomadatos') || (parts.length > 1 && parts[1] === 'upcom')) {
        clientPath = '../client/upcom.tomadatos/inbound/engine-adapter.js';
        clientName = 'Upcom';
    }

    if (clientPath) {
        try {
            // Import relative to services/router/
            const mod = await import(clientPath);
            log('info', `✅ [ROUTER] Routing '${mode}' to ${clientName} Capsule`);
            return mod.default;
        } catch (err) {
            log('error', `❌ [ROUTER] Failed to load ${clientName} Capsule: ${err.message}.`);
            // Continue to legacy fallback if capsule load fails? 
            // Better to fail safe or fallback. Given migration, fallback is safer for uptimes.
        }
    }

    // 2. 🐢 Legacy Fallback (Frozen)
    // Only reachable if not a migrated client, or if capsule failed loading.
    const legacy = await getLegacyRouter();
    if (legacy) {
        try {
            // resolveDomain returns the domain module (which has default export function)
            const domain = await legacy.resolveDomain(mode);
            if (domain) {
                log('info', `⚠️ [ROUTER] Resolved Legacy Domain for '${mode}'`);
                return domain;
            }
        } catch (e) {
            log('warn', `⚠️ [ROUTER] Legacy resolution failed for '${mode}': ${e.message}`);
        }
    }

    log('debug', `[ROUTER] No domain resolved for '${mode}' (Generic Mode)`);
    return null;
}
