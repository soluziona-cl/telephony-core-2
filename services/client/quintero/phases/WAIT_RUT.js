import { log } from '../../../../lib/logger.js';

const MAX_SILENCE_MS = 8000;
const MAX_ATTEMPTS = 4;

/**
 * 🆔 FASE CANÓNICA: WAIT_RUT (Hardened)
 * Unifica la solicitud y escucha del RUT completo con manejo de reintentos y silencios.
 */
export default async function WAIT_RUT(ctx) {
    const { input, state } = ctx;
    const now = Date.now();

    // Recuperar contadores del estado o inicializar
    let attempts = state.rutAttempts || 0;
    const lastListenAt = state.lastListenAt || now;

    // 1️⃣ LOGGING SEMÁNTICO (OBSERVABILIDAD)
    log('debug', '👂 [WAIT_RUT] Estado de escucha', {
        sessionId: ctx.sessionId,
        attempts,
        hasInput: !!(input && input.text),
        timeSinceLastListen: now - lastListenAt
    });

    // 2️⃣ CASO: SILENCIO O NO INPUT
    if (!input || !input.text) {
        const isTimeout = (now - lastListenAt > MAX_SILENCE_MS) && state.rutPrompted;
        const isFirstRun = !state.rutPrompted;

        // Si ya hablamos y no ha pasado el tiempo de timeout, seguimos esperando (loop de polling del engine)
        // PERO: Si el engine nos llama sin input, asumimos que debemos mantener la escucha o manejar timeout
        // En este diseño: Si el engine vuelve a invocar la fase sin input, evaluamos timeout.

        if (!isFirstRun && !isTimeout) {
            // Mantener escucha (Polling corto o re-entrada sin evento significativo)
            return {
                nextPhase: 'WAIT_RUT',
                ttsText: null,
                silent: false,
                skipUserInput: false,
                action: { type: 'SET_STATE' }
            };
        }

        // Aumentar intento si es timeout o primera vez (si primera vez, attempts pasará de 0 a 1)
        if (isFirstRun || isTimeout) {
            attempts++;
        }

        // 3️⃣ CONTROL DE REINTENTOS (ANTI-LOOP)
        if (attempts >= MAX_ATTEMPTS) {
            log('warn', '[METRIC][RUT] Max attempts reached, escalating', { attempts });
            return {
                nextPhase: 'FAILED',
                ttsText: 'No logro escucharle bien. Le transferiré con una ejecutiva para que le ayude.',
                shouldHangup: false, // El estado FAILED maneja la transferencia
                action: { type: 'SET_STATE' },
                statePatch: { rutAttempts: attempts }
            };
        }

        // 4️⃣ PROMPT PROGRESIVO (UX)
        let ttsText = '';

        if (attempts === 1) {
            ttsText = 'Por favor, indique su RUT completo, incluyendo guion y dígito verificador.';
        } else if (attempts === 2) {
            ttsText = 'No le escuché. Por favor repita su RUT. Por ejemplo: doce, millones, trescientos mil, setecientos noventa y cinco, guion k.';
        } else {
            ttsText = 'Aún no le escucho. Puede decir su RUT número por número. Por ejemplo: uno, dos, tres, cuatro, cinco, seis, siete, ocho, guion, nueve.';
        }

        log('info', '[METRIC][RUT] Prompting user', { attempt: attempts, type: isTimeout ? 'timeout' : 'initial' });

        return {
            nextPhase: 'WAIT_RUT',
            ttsText,
            silent: false,        // 🔓 Escucha abierta
            skipUserInput: false, // 🔓 Esperar input
            action: { type: 'SET_STATE' },
            statePatch: {
                rutAttempts: attempts,
                rutPrompted: true,
                lastListenAt: now
            }
        };
    }

    // 5️⃣ CON INPUT: PROCESAMIENTO
    const rut_raw = input.text;

    // Métricas de éxito funcional
    log('info', '[METRIC][RUT] Input received', {
        rut_raw,
        attempts,
        listenTimeMs: now - lastListenAt
    });

    return {
        nextPhase: 'WAIT_RUT',
        ttsText: null,
        silent: false,          // Mantenemos canal (fail-safe)
        skipUserInput: true,    // 🔒 Bloquear input mientras webhook procesa
        action: {
            type: 'WEBHOOK',
            action: 'FORMAT_RUT',
            rut_raw
        }
    };
}
