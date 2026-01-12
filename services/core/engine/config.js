import { voicebotConfigBase } from "./config-base.js";

export const inboundConfig = {
    ...voicebotConfigBase,

    mode: "inbound",

    bargeIn: {
        enabled: true,
        minUserAudioMs: 1500,
        cancelPlaybackOnStart: true,
        minAmplitude: 0.35
    },

    routing: {
        enableQueueTransfer: true,
        queueName: "cola_ventas",
        fallbackToHuman: true,
        queueTimeoutSeconds: 20
    },
    paths: {                                        // Rutas del sistema de archivos
        voicebot: "/var/lib/asterisk/sounds/voicebot", // Directorio de archivos del voicebot (DEBE estar en sounds de Asterisk)
        recordings: "/var/spool/asterisk/recording"    // Directorio de grabaciones de Asterisk
    },

    queues: {                                       // Configuración de colas
        nameQueue: "cola_ventas"                    // Nombre de la cola para transferencias
    },

    bots: {
        "voicebot": {
            prompt: "cpech-cobranza.txt",
            description: "Default Collection Bot",
            requiresDb: false,
            greetingFile: null,                      // Generar saludo con IA
            greetingText: "Hola, le habla Sofía. Estoy aquí para ayudarle con sus consultas."
        },
        // Modo legacy (mantener compatibilidad)
        "voicebot_quintero": {
            prompt: "quintero-confirmacion.txt",
            description: "Quintero Confirmation Bot (legacy)",
            requiresDb: false,
            disableBargeIn: true,                  // 🛡️ Deshabilitar barge-in para adultos mayores
            greetingFile: "greeting_sofia_2",       // Usar audio estático con petición de RUT
            greetingText: "Hola soy Sofia, bienvenido al Consultorio Médico de Quintero. Para poder ayudarlo con su cita médica, primero necesito su RUT. Por favor, indíqueme los números de su RUT, sin el dígito verificador."
        },
        // Nuevo formato con dominio
        "voicebot_identity_quintero": {
            prompt: "quintero-confirmacion.txt",
            description: "Quintero Confirmation Bot (domain-based)",
            requiresDb: true,
            disableBargeIn: true,                  // 🛡️ Deshabilitar barge-in para adultos mayores
            greetingFile: "greeting_sofia_2",
            greetingText: "Hola soy Sofia, bienvenido al Consultorio Médico de Quintero. Para poder ayudarlo con su cita médica, primero necesito su RUT. Por favor, indíqueme su RUT completo, incluyendo el dígito verificador."
        },
        "voicebot_quintero_query": {
            prompt: "quintero-confirmacion.txt",
            description: "Quintero Confirmation Bot with DB queries (prototype)",
            requiresDb: true,
            disableBargeIn: true,                  // 🛡️ Deshabilitar barge-in para adultos mayores
            greetingFile: "greeting_sofia_2",       // Usar audio estático con petición de RUT
            greetingText: "Hola soy Sofia, bienvenido al Consultorio Médico de Quintero. Para poder ayudarlo con su cita médica, primero necesito su RUT. Por favor, indíqueme los números de su RUT, sin el dígito verificador."
        }
    }
};
