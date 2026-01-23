/**
 * ⚙️ Quintero Client Configuration
 * Feature flags and operational settings.
 */
export const config = {
    domain: "quintero",
    features: {
        stt: {
            mode: "batch",
            engine: "openai-whisper",
            retryOn: ["RUT"],
            maxRetries: 2
        }
    }
};
