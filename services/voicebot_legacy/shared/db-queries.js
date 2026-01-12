import { poolPromise as realPoolPromise, sql } from '../../../lib/db.js';
import { log } from '../../../lib/logger.js';
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
  try {
    const pool = await _poolPromise;
    const result = await pool
      .request()
      .input('esp', sql.VarChar, especialidad)
      .input('fecha', sql.Date, fecha)
      .execute('dbo.sp_GetAvailabilityBySpecialty');
    return (result && result.recordset) || [];
  } catch (err) {
    log('error', `getAvailabilityBySpecialty error: ${err.message}`);
    return [];
  }
}

/**
 * Obtiene y reserva temporalmente (HOLD) el siguiente cupo disponible para una especialidad.
 * @param {string} especialidad 
 * @param {string} sessionId 
 */
export async function getAndHoldNextSlot(especialidad, sessionId) {
  try {
    const pool = await _poolPromise;
    const result = await pool
      .request()
      .input('Especialidad', sql.VarChar, especialidad)
      .input('SessionId', sql.VarChar, sessionId)
      .input('HoldSeconds', sql.Int, 300) // 5 minutos de holgura
      // Reemplazamos SP por Query Directa para asegurar "Próxima Disponible" >= Hoy
      // y soportar la tabla CLI_QUINTEROS_disponibilidad_horas
      .query(`
        UPDATE TOP(1) CLI_QUINTEROS_disponibilidad_horas
        SET HoldUntil = DATEADD(second, @HoldSeconds, GETDATE()), 
            SessionId = @SessionId
        OUTPUT inserted.*
        WHERE especialidad = @Especialidad
          AND (Estado = 'DISPONIBLE' OR Estado IS NULL) 
          AND (HoldUntil IS NULL OR HoldUntil < GETDATE())
          AND fecha >= CAST(GETDATE() AS DATE)
          -- Ordenar por fecha y hora para obtener la más próxima real
          -- Nota: Si hora_disponible es solo hora, el orden fecha, hora funciona.
        `);


    const row = (result && result.recordset && result.recordset[0]) || null;
    if (!row || row.status === 'fail') return null;
    return row;
  } catch (err) {
    log('error', `getAndHoldNextSlot error: ${err.message}`);
    return null;
  }
}

/**
 * Scheduling placeholder: scheduling logic depends on the target table and locking strategy.
 */
export async function scheduleAppointment(patientIdOrRut, fechaHora, especialidad, source = 'voicebot', sessionId = null) {
  try {
    const pool = await _poolPromise;

    let pid = null;
    let prut = null;
    if (typeof patientIdOrRut === 'number') pid = patientIdOrRut;
    else if (typeof patientIdOrRut === 'string') prut = patientIdOrRut;

    const req = pool.request();
    req.input('PatientId', sql.Int, pid);
    req.input('PatientRut', sql.VarChar, prut);
    req.input('FechaHora', sql.DateTime, fechaHora);
    req.input('Especialidad', sql.VarChar, especialidad);
    req.input('Source', sql.VarChar, source);
    req.input('SessionId', sql.VarChar, sessionId);

    const res = await req.execute('dbo.sp_ScheduleAppointment');
    const row = (res && res.recordset && res.recordset[0]) || null;
    if (!row) return { ok: false, error: 'no_result' };
    return { ok: (row.status && row.status.toString().toLowerCase() === 'ok') || false, id: row.id || null, disponibilidadId: row.disponibilidadId || null };
  } catch (err) {
    log('error', `scheduleAppointment error: ${err.message}`);
    return { ok: false, error: err.message };
  }
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
