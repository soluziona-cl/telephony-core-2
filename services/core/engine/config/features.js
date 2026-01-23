/**
 * 🚩 FEATURE FLAGS - Control de características por dominio
 */

export const FEATURES = {
    ENABLE_CONTINUOUS_RECORDING_SEGMENTS: process.env.ENABLE_CONTINUOUS_RECORDING_SEGMENTS === "true",
};

/**
 * Feature flags por dominio
 */
export const DomainFeatureFlags = {
    quintero: {
        SEGMENTED_CONTINUOUS_STT: process.env.FEATURE_SEGMENTED_CONTINUOUS_STT_QUINTERO === "1" || FEATURES.ENABLE_CONTINUOUS_RECORDING_SEGMENTS,
    },
    cpech: {
        SEGMENTED_CONTINUOUS_STT: process.env.FEATURE_SEGMENTED_CONTINUOUS_STT_CPECH === "1" || false,
    },
    default: {
        SEGMENTED_CONTINUOUS_STT: process.env.FEATURE_SEGMENTED_CONTINUOUS_STT_DEFAULT === "1" || false,
    }
};

/**
 * Verificar si una feature está habilitada para un dominio
 * @param {string} domainName - Nombre del dominio
 * @param {string} featureName - Nombre de la feature
 * @returns {boolean}
 */
export function isFeatureEnabled(domainName, featureName) {
    const domainFlags = DomainFeatureFlags[domainName] || DomainFeatureFlags.default;
    return domainFlags[featureName] === true;
}
