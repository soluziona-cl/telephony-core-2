import { voicebotConfigBase } from "../shared/voicebot-config-base.js";

export const outboundConfig = {

    ...voicebotConfigBase,

    mode: "outbound",

    openai: {
        ...voicebotConfigBase.openai,

        temperature: 0.25,

        // Estas instrucciones serán reemplazadas dinámicamente por prompt-builder
        // pero dejamos un fallback aquí:
        instructions: "Eres un asistente especializado en cobranza blanda. Tu objetivo es contactar amablemente al cliente para recordarle su deuda y solicitar una fecha de compromiso.",

        vad: {
            ...voicebotConfigBase.openai.vad,
            silenceDurationMs: 350,  // más sensible que inbound
            idleTimeoutMs: 6000      // outbound debe cortar rápido
        }
    },

    engine: {
        ...voicebotConfigBase.engine,
        maxTurns: 6,             // outbound es más corto
        maxSilentTurns: 2        // si no responde → corta
    },

    bargeIn: {
        enabled: false,          // outbound NO admite barge-in
        minUserAudioMs: 0,
        cancelPlaybackOnStart: false
    },

    outbound: {
        initialGreeting: "Hola, te estoy llamando desde CPECH para entregarte información importante.",
        detectAnsweringMachine: true,
        maxWaitHumanVoiceMs: 3000,
        minTalkingEvents: 2
    },

    autoHangupOnResult: true,     // cuando consigue fecha → cuelga
    requireCommitment: true       // obliga al cliente a confirmar fecha
};
