import { log } from "../../../../lib/logger.js";

/**
 * Executes a transfer to a specific queue via Asterisk Dialplan.
 * @param {Object} ari - ARI client instance
 * @param {Object} channel - ARI channel instance
 * @param {string} queueName - Name of the queue (extension in 'queues' context)
 * @returns {Promise<boolean>} - True if transfer initiated successfully
 */
export async function transferToQueue(ari, channel, queueName = "cola_ventas") {
    log("info", `📞 [TRANSFER] INICIANDO Transferencia a cola: ${queueName}`);
    const channelId = channel.id;

    try {
        log("info", `🔄 [TRANSFER] Redirigiendo ${channelId} a contexto: queues, extensión: ${queueName}`);

        await channel.continueInDialplan({
            context: 'queues',
            extension: queueName,
            priority: 1
        });

        log("info", `✅ [TRANSFER] Comando continueInDialplan enviado.`);
        return true;
    } catch (err) {
        log("error", `❌ [TRANSFER] Falló: ${err.message}`);
        return false;
    }
}

/**
 * Determines if a transfer should be initiated based on user intent or assistant response.
 * @param {string} transcript - User audio transcript
 * @param {string} assistantResponse - Last assistant response text
 * @returns {boolean} - True if transfer should occur
 */
export function shouldTransferToQueue(transcript, assistantResponse = "") {
    // 1. Assistant triggered transfer (e.g. "te conecto con un ejecutivo")
    if (!transcript) {
        const lowerResponse = assistantResponse.toLowerCase();
        const transferPhrases = [
            'te conecto con un ejecutivo',
            'te transfiero con un ejecutivo',
            'conectando con ejecutivo',
            'en breve el ejecutivo',
            'te estoy conectando'
        ];

        const detected = transferPhrases.some(phrase => lowerResponse.includes(phrase));
        if (detected) {
            log("info", `🎯 [TRANSFER] Detectado en respuesta del asistente: "${assistantResponse}"`);
        }
        return detected;
    }

    // 2. User requested transfer (Semantic)
    const lowerTranscript = transcript.toLowerCase();

    const TRANSFER_KEYWORDS = [
        'ejecutivo', 'operador', 'agente', 'representante', 'asesor', 'vendedor',
        'humano', 'persona', 'hablar con alguien', 'hablar con una persona',
        'derivar', 'transferir', 'pasar con', 'contactar con',
        'colaborador', 'especialista', 'consultor', 'asistente humano',
        'atencion personal', 'atencion directa', 'servicio al cliente',
        'quiero hablar con', 'necesito hablar con', 'deseo hablar con',
        'me comunico con', 'me pongo con', 'me conectas con'
    ];

    const detected = TRANSFER_KEYWORDS.some(keyword => {
        const regex = new RegExp(`\\b${keyword}\\b`, "i");
        return regex.test(lowerTranscript);
    });

    if (detected) {
        log("info", `🎯 [TRANSFER] Palabra clave detectada: "${transcript}"`);
    }

    return detected;
}
