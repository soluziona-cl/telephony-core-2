import { OpenAI } from "openai";
import { log } from "../../../../lib/logger.js";
import { config } from "dotenv";
config(); // Cargar .env si no está cargado

// Inicializar cliente OpenAI
// Se puede reusar la instancia global si existe, o crear una dedicada para el clasificador
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 6000, // hard timeout
});

/**
 * Clasificador gemelo para VoiceBot
 * - NO genera texto libre
 * - SOLO retorna JSON controlado
 */
export async function classifyInput({
    phase,
    userText,
    rutDetected = null,
}) {
    const systemPrompt = `
Eres un CLASIFICADOR ESTRICTO para un VoiceBot médico.
NO conversas. NO ayudas al usuario.
NO inventas información.
SOLO clasificas.

Reglas:
- Responde SOLO JSON válido
- No agregues texto adicional
- No expliques decisiones
`;

    const userPrompt = buildPrompt({ phase, userText, rutDetected });

    let retries = 0;
    const MAX_RETRIES = 1;

    while (retries <= MAX_RETRIES) {
        try {
            const response = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL_FAST || "gpt-3.5-turbo", // Usar modelo rápido si está definido, o fallback
                temperature: 0,
                max_tokens: 60,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                response_format: { type: "json_object" } // Asegurar respuesta JSON si el modelo lo soporta
            });

            const raw = response.choices[0].message.content;

            // 🔒 Parseo seguro
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                log('warn', `⚠️ [CLASSIFIER] Error parseando JSON: ${raw}`);
                if (retries < MAX_RETRIES) {
                    retries++;
                    continue;
                }
                return { ok: false, error: 'json_parse_error', raw };
            }

            return {
                ok: true,
                result: parsed,
                raw,
            };

        } catch (err) {
            log('error', `❌ [CLASSIFIER] Error OpenAI: ${err.message}`);
            if (retries < MAX_RETRIES) {
                retries++;
                continue;
            }
            return {
                ok: false,
                error: err.message,
            };
        }
    }
}

/**
 * Prompt por fase (alineado a tu motor)
 */
function buildPrompt({ phase, userText, rutDetected }) {
    switch (phase) {
        case "CONFIRM":
            return `
FASE: CONFIRM

RUT detectado previamente: ${rutDetected}

Texto del usuario:
"${userText}"

Clasifica la intención del usuario respecto a la confirmación del RUT.

Devuelve SOLO uno de estos valores:

{
  "confirmation": "YES" | "NO" | "UNKNOWN"
}

Ejemplos:
- "sí", "correcto", "así es", "aquí es correcto", "ese mismo", "si" → YES
- "no", "incorrecto", "está mal", "equivocado", "no es" → NO
- cualquier otra cosa, ruido, duda → UNKNOWN
`;

        case "DATE_INTENT":
            return `
FASE: DATE_INTENT

Texto del usuario:
"${userText}"

Clasifica la intención de fecha.

Devuelve SOLO este JSON:

{
  "date_type": "EXACT_DATE" | "NEXT_AVAILABLE" | "UNKNOWN",
  "date": "YYYY-MM-DD" | null
}

Reglas:
- Si dice "la más próxima", "la más cercana", "cuando haya", "la primera" → NEXT_AVAILABLE
- Si dice una fecha clara (ej: "lunes 3", "mañana") → EXACT_DATE (formato YYYY-MM-DD, asume año actual ${new Date().getFullYear()} si no se dice)
- Si no se puede inferir → UNKNOWN
`;

        default:
            return `
FASE DESCONOCIDA.

Devuelve:
{
  "error": "UNSUPPORTED_PHASE"
}
`;
    }
}
