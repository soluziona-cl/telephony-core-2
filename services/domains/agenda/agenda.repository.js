import { poolPromise, sql } from '../../../lib/db.js';
import { log } from '../../../lib/logger.js';
import { poolPromise, sql } from '../../../lib/db.js';
import { log } from '../../../lib/logger.js';
import { AGENDA_CONSTANTS } from './agenda.types.js';
import { flowTrace } from '../../core/telemetry/flow-trace.js';

/**
 * Agenda Repository
 * Encapsulates direct database access for appointments and scheduling.
 */

/**
 * Obtiene y reserva temporalmente (HOLD) el siguiente cupo disponible para una especialidad.
 * @param {string} especialidad 
 * @param {string} sessionId 
 * @returns {Promise<import('./agenda.types.js').AppointmentSlot | null>}
 */
export async function getAndHoldNextSlot(especialidad, sessionId) {
    flowTrace({
        traceId: sessionId,
        layer: 'REPOSITORY',
        flow: 'AGENDA',
        step: 'HOLD_SLOT',
        depth: 3,
        module: 'domains/agenda/agenda.repository.js',
        fn: 'getAndHoldNextSlot',
        action: 'EXEC_SQL',
        result: 'START'
    });
    try {
        const pool = await poolPromise;
        const result = await pool
            .request()
            .input('Especialidad', sql.VarChar, especialidad)
            .input('SessionId', sql.VarChar, sessionId)
            .input('HoldSeconds', sql.Int, AGENDA_CONSTANTS.HOLD_DURATION_SECONDS)
            .query(`
        UPDATE TOP(1) CLI_QUINTEROS_disponibilidad_horas
        SET HoldUntil = DATEADD(second, @HoldSeconds, GETDATE()), 
            SessionId = @SessionId
        OUTPUT inserted.*
        WHERE especialidad = @Especialidad
          AND (Estado = 'DISPONIBLE' OR Estado IS NULL) 
          AND (HoldUntil IS NULL OR HoldUntil < GETDATE())
          AND fecha >= CAST(GETDATE() AS DATE)
      `);

        const row = (result && result.recordset && result.recordset[0]) || null;
        if (!row || row.status === 'fail') return null;

        flowTrace({
            traceId: sessionId,
            layer: 'REPOSITORY',
            flow: 'AGENDA',
            step: 'HOLD_SLOT',
            depth: 3,
            module: 'domains/agenda/agenda.repository.js',
            fn: 'getAndHoldNextSlot',
            action: 'EXEC_SQL',
            result: 'FOUND'
        });
        return row;
    } catch (err) {
        log('error', `[AGENDA REPO] getAndHoldNextSlot error: ${err.message}`);
        return null;
    }
}

/**
 * Retrieves availability by specialty and date.
 * @param {string} especialidad 
 * @param {string|Date} fecha 
 */
export async function getAvailabilityBySpecialty(especialidad, fecha) {
    try {
        const pool = await poolPromise;
        const result = await pool
            .request()
            .input('esp', sql.VarChar, especialidad)
            .input('fecha', sql.Date, fecha)
            .execute('dbo.sp_GetAvailabilityBySpecialty');
        return (result && result.recordset) || [];
    } catch (err) {
        log('error', `[AGENDA REPO] getAvailabilityBySpecialty error: ${err.message}`);
        return [];
    }
}

/**
 * Confirm and schedule an appointment.
 * @param {object} params
 * @param {number|string} params.patientIdOrRut
 * @param {Date} params.fechaHora
 * @param {string} params.especialidad
 * @param {string} [params.source='voicebot']
 * @param {string} [params.sessionId]
 * @returns {Promise<import('./agenda.types.js').AppointmentConfirmation>}
 */
export async function scheduleAppointment({ patientIdOrRut, fechaHora, especialidad, source = 'voicebot', sessionId = null }) {
    try {
        const pool = await poolPromise;

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

        return {
            ok: (row.status && row.status.toString().toLowerCase() === 'ok') || false,
            id: row.id || null,
            disponibilidadId: row.disponibilidadId || null
        };
    } catch (err) {
        log('error', `[AGENDA REPO] scheduleAppointment error: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

/**
 * Releases a held slot for a session.
 * @param {string} sessionId
 */
export async function releaseHeldSlot(sessionId) {
    try {
        const pool = await poolPromise;
        // Logic to clear hold. Often implicit by timeout, but explicit release is good.
        // Assuming update query or SP logic.
        // For now, mirroring the implicit release via timeout or direct update if needed.
        // Since original legacy-compat didn't have explicit release except via timeout or confirm,
        // we'll implement a direct release query for completeness.
        await pool.request()
            .input('SessionId', sql.VarChar, sessionId)
            .query(`
                UPDATE CLI_QUINTEROS_disponibilidad_horas
                SET HoldUntil = NULL, SessionId = NULL
                WHERE SessionId = @SessionId AND Estado = 'DISPONIBLE'
            `);
        return true;
    } catch (err) {
        log('error', `[AGENDA REPO] releaseHeldSlot error: ${err.message}`);
        return false;
    }
}
