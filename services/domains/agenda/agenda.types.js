/**
 * @typedef {Object} AppointmentSlot
 * @property {number} id_disponibilidad
 * @property {Date} fecha
 * @property {Date} hora_disponible
 * @property {string} especialidad
 * @property {string} doctor_box
 * @property {string} [requisito]
 * @property {string} [status]
 * @property {Date} [holdUntil]
 */

/**
 * @typedef {Object} AppointmentConfirmation
 * @property {boolean} ok
 * @property {number} [id]
 * @property {number} [disponibilidadId]
 * @property {string} [error]
 */

export const AGENDA_CONSTANTS = {
    HOLD_DURATION_SECONDS: 300
};
