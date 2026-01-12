/**
 * 🗣️ Mensajes TTS para el bot Quintero
 * Todos los mensajes de voz que el bot puede decir
 */

/**
 * Genera mensaje para solicitar RUT completo
 */
export function askRut() {
  return 'Por favor, indíqueme su RUT completo, incluyendo el dígito verificador.';
}

/**
 * Genera mensaje de confirmación de RUT
 * @param {string} maskedReading - Lectura enmascarada del RUT (ej: "dos cinco ocho guión ocho")
 */
export function confirmRut(maskedReading) {
  return `Tengo registrado el RUT terminado en ${maskedReading}. ¿Es correcto?`;
}

/**
 * Mensaje cuando el usuario confirma correctamente
 */
export function confirmOk() {
  return 'Perfecto, muchas gracias. Un momento por favor.';
}

/**
 * Mensaje cuando el usuario rechaza y se reinicia el flujo
 */
export function confirmRetry() {
  return 'De acuerdo, intentemos nuevamente. Por favor indique su RUT completo.';
}

/**
 * Mensaje cuando no se entiende la confirmación (primer intento)
 * @param {string} maskedReading - Lectura enmascarada del RUT
 */
export function confirmRepeat(maskedReading) {
  return `No le entendí bien. Tengo el RUT terminado en ${maskedReading}. ¿Es correcto? Dígame sí o no.`;
}

/**
 * Mensaje corto para segundo intento de confirmación
 */
export function confirmRepeatShort() {
  return '¿Es correcto, sí o no?';
}

/**
 * Mensaje cuando falla la confirmación después de múltiples intentos
 */
export function confirmFailEscalate() {
  return 'No logro confirmar su RUT. Le transferiré con un ejecutivo.';
}

/**
 * Mensaje cuando falta el dígito verificador
 */
export function askDv() {
  return 'Me faltó el dígito verificador. Por favor dígame solo el dígito verificador, por ejemplo: guión ocho, o guión k.';
}

/**
 * Mensaje cuando no se entiende el RUT (intento intermedio)
 */
export function askRutRetry() {
  return 'Por favor, indíqueme su RUT completo, incluyendo el dígito verificador. Por ejemplo: catorce millones, trescientos cuarenta mil, guión ocho.';
}

/**
 * Mensaje cuando se exceden los intentos de captura
 */
export function rutCaptureFailed() {
  return 'No logro capturar su RUT correctamente. Le transferiré con un ejecutivo.';
}

/**
 * Mensaje cuando el RUT es inválido matemáticamente
 */
export function rutInvalid() {
  return 'El RUT que escuché no es válido. Por favor dígame su RUT completo nuevamente, con el dígito verificador.';
}

/**
 * Mensaje cuando se corrige solo el DV
 * @param {string} maskedReading - Lectura enmascarada del RUT corregido
 */
export function dvCorrected(maskedReading) {
  return `Perfecto. Tengo el RUT terminado en ${maskedReading}. ¿Es correcto?`;
}

/**
 * Mensaje cuando el DV corregido sigue siendo inválido
 */
export function dvInvalid() {
  return 'El dígito verificador que escuché no es válido. Por favor dígalo nuevamente.';
}

/**
 * Mensaje cuando se encuentra el paciente en la base de datos
 * @param {string} nombreCompleto - Nombre completo del paciente
 */
export function patientFound(nombreCompleto) {
  return `Gracias. He validado sus datos y lo encontré en el sistema como ${nombreCompleto}. ¿En qué puedo ayudarle?`;
}

/**
 * Mensaje cuando el RUT es válido pero no está en la base de datos
 */
export function patientNotFound() {
  return 'No fue posible validar sus datos. Por favor, comuníquese con el consultorio.';
}

/**
 * Mensaje cuando no hay horas disponibles
 */
export function noAvailability() {
  return 'No encontré horas disponibles para esa especialidad.';
}

/**
 * Mensaje cuando la especialidad no está mapeada
 */
export function specialtyNotMapped() {
  return 'No encontré horas para esa especialidad.';
}

/**
 * Mensaje cuando el hold expiró o no existe
 */
export function holdExpired() {
  return 'La hora ya no está disponible, busquemos otra.';
}

/**
 * Mensaje para ofrecer otra especialidad cuando no hay horas
 */
export function offerAnotherSpecialty() {
  return 'Para la especialidad indicada no hay horas disponibles. Si desea consultar por otra, diga sí. Si prefiere llamar en otro momento, diga no.';
}

/**
 * Mensaje para denegar cambio de RUT por seguridad
 */
export function denyRutChange() {
  return 'Por motivos de seguridad, para consultar otro RUT debe llamar nuevamente. Hasta luego.';
}

/**
 * Despedida genérica
 */
export function farewell() {
  return 'Muchas gracias, hasta luego.';
}

/**
 * Exportar objeto con todas las funciones para fácil acceso
 */
export const tts = {
  askRut,
  confirmRut,
  confirmOk,
  confirmRetry,
  confirmRepeat,
  confirmRepeatShort,
  confirmFailEscalate,
  askDv,
  askRutRetry,
  rutCaptureFailed,
  rutInvalid,
  dvCorrected,
  dvInvalid,
  patientFound,
  patientNotFound,
  noAvailability,
  specialtyNotMapped,
  holdExpired,
  offerAnotherSpecialty,
  denyRutChange,
  farewell
};

export default tts;

