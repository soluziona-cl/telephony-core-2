/**
 * 🎯 Handler para fase ASK_DATE
 * Consulta la fecha deseada para la cita
 */

import { log } from '../../../../../lib/logger.js';
import * as tts from '../tts/messages.js';

/**
 * Clasifica la intención de fecha
 */
function classifyDateIntent(transcript) {
  const text = (transcript || '').toLowerCase().trim();
  
  if (text.includes('hoy') || text.includes('ahora') || text.includes('mismo')) {
    return { type: 'TODAY', date: new Date().toISOString().split('T')[0] };
  }
  
  if (text.includes('mañana') || text.includes('manana')) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { type: 'TOMORROW', date: tomorrow.toISOString().split('T')[0] };
  }
  
  if (text.includes('lo antes posible') || text.includes('pronto') || text.includes('primer')) {
    return { type: 'ASAP', date: null }; // Se buscará la primera disponible
  }
  
  // Intentar extraer fecha específica (formato simple)
  const dateMatch = text.match(/(\d{1,2})\s*(de|\/)\s*(\w+)/);
  if (dateMatch) {
    // Parseo básico de fecha (se puede mejorar)
    return { type: 'SPECIFIC', date: null }; // Por ahora, delegar al webhook
  }
  
  return { type: 'UNKNOWN', date: null };
}

/**
 * Maneja la fase ASK_DATE
 * @param {object} ctx - Contexto de la sesión (transcript, sessionId)
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function askDate(ctx, state) {
  const { transcript } = ctx;
  
  // Si no hay transcript, es la primera vez que se pregunta
  if (!transcript || transcript.trim().length === 0) {
    return {
      ttsText: "¿Desea agendar para hoy o para otra fecha?",
      nextPhase: 'ASK_DATE',
      shouldHangup: false,
      action: {
        type: "SET_STATE",
        payload: {
          updates: {
            rutPhase: 'ASK_DATE'
          }
        }
      }
    };
  }
  
  const cleanTranscript = (transcript || '').toLowerCase().trim();
  log("info", `[ASK_DATE] Interpretando: "${cleanTranscript}"`);
  
  const dateIntent = classifyDateIntent(cleanTranscript);
  
  if (dateIntent.type !== 'UNKNOWN') {
    // ✅ Fecha identificada → avanzar a CHECK_AVAILABILITY
    state.fecha_solicitada = dateIntent.date || 'ASAP';
    state.dateAttempts = 0;
    state.rutPhase = 'CHECK_AVAILABILITY';
    
    log("info", `✅ [ASK_DATE] Fecha identificada: ${dateIntent.type} (${state.fecha_solicitada || 'ASAP'})`);
    
    return {
      ttsText: "Perfecto, estoy buscando disponibilidad.",
      nextPhase: 'CHECK_AVAILABILITY',
      shouldHangup: false,
      action: {
        type: "SET_STATE",
        payload: {
          updates: {
            fecha_solicitada: state.fecha_solicitada,
            rutPhase: 'CHECK_AVAILABILITY'
          }
        }
      }
    };
  }
  
  // ❌ Fecha no identificada → incrementar intentos
  state.dateAttempts = (state.dateAttempts || 0) + 1;
  log("warn", `⚠️ [ASK_DATE] Fecha no identificada. Intento #${state.dateAttempts}`);
  
  if (state.dateAttempts >= 3) {
    // Máximo de intentos → usar ASAP
    state.fecha_solicitada = 'ASAP';
    state.rutPhase = 'CHECK_AVAILABILITY';
    
    return {
      ttsText: "Buscando la primera hora disponible.",
      nextPhase: 'CHECK_AVAILABILITY',
      shouldHangup: false,
      action: {
        type: "SET_STATE",
        payload: {
          updates: {
            fecha_solicitada: 'ASAP',
            rutPhase: 'CHECK_AVAILABILITY'
          }
        }
      }
    };
  }
  
  // Repetir pregunta
  return {
    ttsText: "¿Desea agendar para hoy, mañana o lo antes posible?",
    nextPhase: 'ASK_DATE',
    shouldHangup: false,
    action: {
      type: "SET_STATE",
      payload: {
        updates: {
          dateAttempts: state.dateAttempts
        }
      }
    }
  };
}

