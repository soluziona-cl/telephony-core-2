/**
 * 📋 WAIT_BODY Phase
 * Explicit logic for the main inputs capture phase.
 * Replaces implicit "engine assumption" or "prompt-driven" flow.
 */
module.exports = async function WAIT_BODY(ctx) {
    const transcript = (ctx.transcript || '').trim();

    // Caso 1: No hay input (Inicio de fase o silencio)
    // El dominio decide explícitamente qué decir.
    if (!transcript) {
        // Si estamos en inicio de llamada (sin history), es el SALUDO.
        // Si ya hablamos y hubo silencio, es un RE-PROMPT.
        // Simplicidad: WAIT_BODY siempre pide el RUT si no hay input.
        return {
            nextPhase: 'WAIT_BODY',
            ttsText: 'Hola, bienvenido al Consultorio de Quintero. Para ayudarle, necesito su RUT completo, incluyendo el dígito verificador. ¿Me lo puede indicar por favor?',
            silent: false,
            skipUserInput: false,
            action: { type: 'SET_STATE' }
        };
    }

    // Caso 2: Hay input -> Intentar formatear/validar o pasar a siguiente fase
    // En este diseño simple, asumimos que el input es el RUT y pasamos a formatearlo.
    // El engine o la siguiente fase (FORMAT_RUT) se encargará de la validación técnica.
    // Aquí podríamos pre-validar si quisiéramos ser más estrictos.

    return {
        nextPhase: 'FORMAT_RUT', // Ficticia o real, según tu mapa de fases. Ojo: El user mencionó FORMAT_RUT como webhook? 
        // Revisando log del user: "WAIT_BODY -> FORMAT_RUT". 
        // Si FORMAT_RUT es un webhook, el engine lo llamará, o si es una fase lógica, transicionamos.
        // Asumiremos transición de estado para que el engine maneje la lógica de RUT.
        ttsText: null, // No hablar, procesar
        silent: true,  // Silencio mientras procesa
        skipUserInput: true,
        action: {
            type: 'SET_STATE',
            payload: {
                updates: {
                    rutBody: null // Limpiar previos
                }
            }
        },
        statePatch: { rawInput: transcript }
    };
};
