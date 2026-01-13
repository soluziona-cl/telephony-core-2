import { poolPromise as realPoolPromise, sql } from '../../../../lib/db.js';
import { log } from '../../../../lib/logger.js';
import { maskRut } from './utils.js';

// internal poolPromise to allow injection during tests
let _poolPromise = realPoolPromise;

export function setPoolPromiseForTests(promise) {
  _poolPromise = promise;
}

/**
 * Consultas utilitarias para el voicebot (MSSQL) adaptadas al esquema CLI_QUINTEROS
 * - CLI_QUINTEROS_pacientes(rut PK, nombre_completo, edad, observacion)
 * - CLI_QUINTEROS_disponibilidad_horas(id_disponibilidad, especialidad, hora_disponible, doctor_box, requisito, fecha)
 */

export async function getPatientByRut(rut) {
  try {
    const pool = await _poolPromise;
    // Use stored procedure for lookups
    const result = await pool.request().input('rut', sql.VarChar, rut).execute('dbo.sp_GetPatientByRut');
    const row = (result && result.recordset && result.recordset[0]) || null;
    if (!row) return null;
    return {
      rut: row.rut,
      nombre_completo: row.nombre_completo,
      edad: row.edad !== undefined ? row.edad : null,
      observacion: row.observacion || null
    };
  } catch (err) {
    log('error', `getPatientByRut error: ${err.message} (rut=${maskRut(rut)})`);
    return null;
  }
}

/**
 * Buscar paciente por ANI (teléfono). CLI_QUINTEROS_pacientes no guarda teléfonos,
 * por eso intentamos caer en la tabla legacy `Patients` si existe.
 */
export async function getPatientByAni(ani) {
  try {
    const pool = await _poolPromise;
    const res = await pool.request().input('ani', sql.VarChar, ani).execute('dbo.sp_GetPatientByAni');
    return (res && res.recordset && res.recordset[0]) || null;
  } catch (err) {
    log('error', `getPatientByAni error: ${err.message}`);
    return null;
  }
}

export async function getNextAppointment(patientId) {
  try {
    const pool = await _poolPromise;
    const res = await pool.request().input('pid', sql.Int, patientId).execute('dbo.sp_GetNextAppointmentForPatient');
    return (res && res.recordset && res.recordset[0]) || null;
  } catch (err) {
    // Table may not exist in this schema; log and return null
    log('warn', `getNextAppointment warning: ${err.message}`);
    return null;
  }
}

export async function getAvailabilityBySpecialty(especialidad, fecha) {
  const { getAvailabilityBySpecialty: repoGetAvail } = await import('../../../domains/agenda/agenda.repository.js');
  return repoGetAvail(especialidad, fecha);
}

/**
 * Obtiene y reserva temporalmente (HOLD) el siguiente cupo disponible para una especialidad.
 * @param {string} especialidad 
 * @param {string} sessionId 
 */
export async function getAndHoldNextSlot(especialidad, sessionId) {
  // Delegate to new Agenda Repository
  const { getAndHoldNextSlot: repoGetAndHold } = await import('../../../domains/agenda/agenda.repository.js');
  return repoGetAndHold(especialidad, sessionId);
}

/**
 * Scheduling callback.
 */
export async function scheduleAppointment(patientIdOrRut, fechaHora, especialidad, source = 'voicebot', sessionId = null) {
  const { scheduleAppointment: repoSchedule } = await import('../../../domains/agenda/agenda.repository.js');
  return repoSchedule({ patientIdOrRut, fechaHora, especialidad, source, sessionId });
}

/**
 * Consulta el mapeo de especialidades desde la tabla Especialidad_Map
 * Estructura real: especialidad_input (sinónimo), especialidad_canonica (especialidad canónica)
 * @param {string} transcript - Texto del usuario a buscar
 * @returns {Promise<object>} - { found: boolean, specialty: string|null, confidence: string }
 */
export async function getSpecialtyFromMap(transcript) {
  try {
    const pool = await _poolPromise;
    const text = (transcript || '').toLowerCase().trim();

    if (!text || text.length === 0) {
      return { found: false, specialty: null, confidence: 'none' };
    }

    // Consultar tabla Especialidad_Map con estructura real:
    // - especialidad_input: sinónimo o palabra clave del usuario
    // - especialidad_canonica: nombre canónico de la especialidad
    // - activo: flag para habilitar/deshabilitar registros
    const result = await pool
      .request()
      .input('text', sql.VarChar, text)
      .input('textLike', sql.VarChar, `%${text}%`)
      .query(`
        SELECT TOP 1 
          especialidad_canonica,
          especialidad_input
        FROM Especialidad_Map
        WHERE activo = 1
          AND (
            LOWER(especialidad_input) = LOWER(@text)
            OR LOWER(especialidad_input) LIKE @textLike
            OR LOWER(especialidad_canonica) LIKE @textLike
          )
        ORDER BY 
          -- Priorizar coincidencias exactas
          CASE 
            WHEN LOWER(especialidad_input) = LOWER(@text) THEN 1
            WHEN LOWER(especialidad_canonica) = LOWER(@text) THEN 2
            ELSE 3
          END,
          -- Luego por longitud (más corto = más específico)
          LEN(especialidad_input) ASC
      `);

    if (result.recordset && result.recordset.length > 0) {
      const row = result.recordset[0];
      const specialty = row.especialidad_canonica || null;

      if (specialty) {
        // Verificar si es coincidencia exacta o parcial
        const exactMatch = text === (row.especialidad_input || '').toLowerCase() ||
          text === (row.especialidad_canonica || '').toLowerCase();

        log('debug', `getSpecialtyFromMap: encontrado "${specialty}" para input "${text}" (exact: ${exactMatch})`);

        return {
          found: true,
          specialty: specialty,
          confidence: exactMatch ? 'high' : 'medium'
        };
      }
    }

    return { found: false, specialty: null, confidence: 'none' };
  } catch (err) {
    log('error', `getSpecialtyFromMap error: ${err.message}`);
    // Fallback a mapeo local si la tabla no existe o hay error
    return { found: false, specialty: null, confidence: 'none' };
  }
}

export default {
  setPoolPromiseForTests,
  getPatientByRut,
  getPatientByAni,
  getNextAppointment,
  getAvailabilityBySpecialty,
  getAndHoldNextSlot,
  scheduleAppointment,
  getSpecialtyFromMap
};
