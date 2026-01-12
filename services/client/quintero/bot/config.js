/**
 * ⚙️ Configuración del bot Quintero
 * Retries, timeouts, UX y reglas específicas del dominio
 */

export const config = {
  // Intentos máximos
  maxRutAttempts: 3,
  maxConfirmAttempts: 2,
  maxDvAttempts: 3,

  // Timeouts (en milisegundos)
  timeout: {
    rutCapture: 30000,      // 30 segundos para capturar RUT
    confirm: 15000,         // 15 segundos para confirmar
    dvCapture: 20000        // 20 segundos para capturar DV
  },

  // UX para adultos mayores
  ux: {
    slowPace: true,         // Hablar más pausado
    repeatOnUnknown: true,  // Repetir en caso de respuesta ambigua
    implicitAcceptance: true // Aceptación implícita después de 2 intentos
  },

  // Reglas sanitarias
  rules: {
    strictMode: ['CONFIRM', 'WAIT_DV'], // Fases en modo estricto
    allowDvMismatch: true,               // Permitir confirmación aunque DV no calce
    maskRutInTts: true                   // Enmascarar RUT en TTS (solo últimos 3 dígitos)
  }
};

export default config;

