export default {
    openai: {
        model: "gpt-realtime",                      // Modelo de OpenAI a utilizar
        temperature: 0.7,                           // Control de creatividad en respuestas (0-1)
        maxResponseTokens: 1800,                    // Límite máximo de tokens por respuesta
        voice: "marin",                             // Voz seleccionada para el asistente
        language: "es",                             // Idioma del asistente (español)
        instructions: [                             // Prompt e instrucciones de comportamiento del agente
            "Eres Paula, un asistente vocal amable, empático y especializado en Cobranza Blanda.\n" +
            "Al iniciar la conversación debes presentarte de forma cordial diciendo algo similar a:\n" +
            "“Hola, te saluda Paula del área de cobranza. Estoy aquí para ayudarte con tu gestión pendiente.”\n\n" +

            "Antes de comenzar, debes generar dos datos aleatorios:\n" +
            "1) Un monto de deuda entre $120.000 y $180.000 CLP.\n" +
            "2) Una fecha de vencimiento ocurrida entre 5 y 10 días antes del día actual.\n\n" +

            "Debes mencionarlos de manera natural al inicio, por ejemplo:\n" +
            "“Según registro, tienes un saldo pendiente de $[MONTO_ALEATORIO], el cual venció hace [X] días.”\n\n" +

            "Tu objetivo principal es ayudar al cliente a regularizar su deuda solicitando de manera cordial y profesional una fecha de compromiso de pago.\n" +
            "Mantén siempre un tono cercano y comprensivo, sin presión.\n\n" +

            "Formula preguntas claras como:\n" +
            "- “¿Para qué fecha podrías realizar el pago?”\n" +
            "- “¿Qué día te acomoda para comprometer el pago?”\n" +
            "- “¿Cuándo crees que podrás regularizarlo?”\n\n" +

            "Si el cliente entrega una fecha, confírmala, agradécelo y valida diciendo algo como:\n" +
            "“Perfecto, entonces quedamos con compromiso para [FECHA]. ¿Lo registramos así?”\n\n" +
            "Importante!!: Debes validar si la [FECHA] entrega para pago es valida en el calendario.\n\n" +
            "Si el cliente solicita hablar con un ejecutivo, operador, agente, representante o humano, responde únicamente:\n" +
            "“Claro, te conecto con un ejecutivo.”\n" +
            "sin explicar nada más.\n\n" +

            "No digas que no tienes acceso, permisos o limitaciones.\n" +
            "No menciones el sistema ni cómo funciona la transferencia.\n" +
            "Este proceso será manejado internamente.\n\n" +

            "En todo momento mantén un tono amable, profesional y orientado a resolver, evitando frases técnicas o negativas.\n" +
            "Tu enfoque siempre será obtener la fecha de compromiso y ayudar al cliente."
        ].join(" "),
        minAudioMs: 180,                            // Duración mínima de audio para procesar
        logPartialTranscripts: false,               // Log de transcripciones parciales (sí/no)
        vad: {                                      // Configuración de detección de actividad vocal
            type: "semantic",                       // Tipo de VAD (detección semántica)
            threshold: 0.55,                        // Umbral de sensibilidad para detección
            prefixPaddingMs: 250,                   // Padding antes del inicio de voz
            silenceDurationMs: 700,                 // Duración de silencio para fin de utterance
            idleTimeoutMs: 12000                    // Timeout por inactividad
        }
    },

    bargeIn: {                                      // Configuración de interrupción por voz
        enabled: true,                              // Barge-in activado/desactivado
        minUserAudioMs: 800,                        // Duración mínima de audio de usuario para barge-in
        cancelPlaybackOnStart: true,                // Cancelar reproducción al iniciar barge-in
        minAmplitude: 0.22                          // Amplitud mínima para detectar barge-in
    },

    turnDetection: {                                // Configuración de detección de turnos
        type: "vad",                                // Tipo de detección (VAD del servidor)
        threshold: 0.65,                            // Umbral para detección de voz
        retryDelayMs: 300,                          // Retardo entre reintentos de detección
        minEnergy: 50,                              // Energía mínima para detección inicial
        minEnergyFinal: 40,                         // Energía mínima para detección final
        prefixPaddingMs: 350,                       // Padding antes del inicio de voz
        silenceDurationMs: 500,                     // Duración de silencio para fin de turno
        endOfUtteranceDelayMs: 150,                 // Retardo después del fin de utterance
        idleTimeoutMs: 10000                        // Timeout por inactividad en turno
    },

    audio: {                                        // Configuración general de audio
        minWavSizeBytes: 2000,                      // Tamaño mínimo de archivo WAV válido
        silenceThreshold: 420,                      // Umbral de silencio para grabación
        maxSilenceSeconds: 2.5,                     // Segundos máximos de silencio permitidos
        maxRecordingMs: 6500,                       // Duración máxima de grabación en milisegundos
        talkingDebounceMs: 400,                     // Tiempo de debounce para detección de voz
        playbackTimeoutMs: 14000,                   // Timeout para reproducción de audio
        maxWaitMs: 4000,                            // Tiempo máximo de espera para voz
        minTalkingEvents: 1                         // Eventos mínimos de voz para considerar activo
    },

    engine: {                                       // Configuración del motor de voz
        maxTurns: 20,                               // Número máximo de turnos por conversación
        maxSilentTurns: 4                           // Turnos silenciosos consecutivos antes de finalizar
    },

    paths: {                                        // Rutas del sistema de archivos
        voicebot: "/var/lib/asterisk/sounds/voicebot", // Directorio de archivos del voicebot
        recordings: "/var/spool/asterisk/recording"    // Directorio de grabaciones de Asterisk
    },

    queues: {                                       // Configuración de colas
        nameQueue: "cola_ventas"                    // Nombre de la cola para transferencias
    }
};