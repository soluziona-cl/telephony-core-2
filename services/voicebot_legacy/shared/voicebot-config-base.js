export const voicebotConfigBase = {
    openai: {
        model: "gpt-realtime",
        temperature: 0.7,
        maxResponseTokens: 1800,
        voice: "marin",
        language: "es",
        instructions: "",
        minAudioMs: 180,
        logPartialTranscripts: false,
        vad: {
            type: "semantic",
            threshold: 0.55,
            prefixPaddingMs: 250,
            silenceDurationMs: 600,
            idleTimeoutMs: 10000
        }
    },
    tts: {
        provider: "openai",    // ← ⬅️ Nuevo
        elevenlabs: {
            voiceId: "",
            model: "eleven_turbo_v2",
            stability: 0.5,
            similarityBoost: 0.75
        }
    },
    logging: {
        rawEvents: false,           // desactiva eventos completos
        audioDelta: false,          // desactiva logs de delta de audio
        openaiDebug: false,         // desactiva logs debug de OpenAI
        transcripts: true,          // mantiene solo transcripts finales
        assistantMessages: true     // muestra solo mensajes finales
    },
    
    audio: {
        minWavSizeBytes: 2000,
        silenceThreshold: 420,
        maxSilenceSeconds: 2.5,
        maxRecordingMs: 6500,
        talkingDebounceMs: 400,
        playbackTimeoutMs: 14000,
        maxWaitMs: 4000,
        minTalkingEvents: 1
    },

    turnDetection: {
        type: "vad",
        threshold: 0.65,
        retryDelayMs: 300,
        minEnergy: 50,
        minEnergyFinal: 40,
        prefixPaddingMs: 350,
        silenceDurationMs: 500,
        endOfUtteranceDelayMs: 150,
        idleTimeoutMs: 10000
    },

    paths: {
        voicebot: "/var/lib/asterisk/sounds/voicebot",
        recordings: "/var/spool/asterisk/recording"
    },

    engine: {
        maxTurns: 20,
        maxSilentTurns: 4
    }
};
