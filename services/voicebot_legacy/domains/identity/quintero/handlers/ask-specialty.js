/**
 * 🎯 Handler para fase ASK_SPECIALTY
 * Pregunta al usuario qué especialidad médica necesita
 */

import { log } from '../../../../../../lib/logger.js';
import * as tts from '../tts/messages.js';

/**
 * Maneja la fase ASK_SPECIALTY
 * @param {object} ctx - Contexto de la sesión (transcript, sessionId)
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function askSpecialty(ctx, state) {
  const { transcript } = ctx;
  
  // Si no hay transcript, es la primera vez que se pregunta
  if (!transcript || transcript.trim().length === 0) {
    const nombre = state.nombre_paciente ? state.nombre_paciente.split(' ')[0] : '';
    const saludo = nombre ? `Gracias, señor ${nombre}.` : 'Gracias.';
    
    return {
      ttsText: `${saludo} ¿Para qué especialidad médica necesita agendar su hora? Por ejemplo, medicina general, control o alguna especialidad en particular.`,
      nextPhase: 'ASK_SPECIALTY', // Mantener fase para esperar respuesta
      shouldHangup: false,
      action: {
        type: "SET_STATE",
        payload: {
          updates: {
            rutPhase: 'ASK_SPECIALTY'
          }
        }
      }
    };
  }
  
  // Si hay transcript, ya se preguntó, avanzar a parsear
  log("info", `[ASK_SPECIALTY] Transcript recibido, avanzando a PARSE_SPECIALTY`);
  state.rutPhase = 'PARSE_SPECIALTY';
  
  // Importar y llamar al handler de parseo
  const parseSpecialty = (await import('./parse-specialty.js')).default;
  return await parseSpecialty(ctx, state);
}

