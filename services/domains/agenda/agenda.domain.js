import { log } from '../../../lib/logger.js';
import * as repo from './agenda.repository.js';
import { log } from '../../../lib/logger.js';
import * as repo from './agenda.repository.js';
import * as types from './agenda.types.js';
import { flowTrace } from '../../core/telemetry/flow-trace.js';

/**
 * Agenda Domain
 * Business logic for appointment scheduling.
 */

export class AgendaDomain {
    /**
     * Find the next available slot for a specialty and hold it.
     * @param {string} specialty 
     * @param {string} sessionId 
     */
    async findAndHoldNextSlot(specialty, sessionId) {
        log('info', `[AGENDA DOMAIN] Looking for next slot for ${specialty} (Session: ${sessionId})`);

        flowTrace({
            traceId: sessionId,
            layer: 'DOMAIN',
            flow: 'AGENDA',
            step: 'FIND_SLOT',
            depth: 2,
            module: 'domains/agenda/agenda.domain.js',
            fn: 'findAndHoldNextSlot',
            action: 'INVOKE_REPO',
            result: 'START'
        });

        const slot = await repo.getAndHoldNextSlot(specialty, sessionId);

        if (!slot) {
            log('info', `[AGENDA DOMAIN] No slots found for ${specialty}`);
            return null;
        }

        // Format for consumption
        return {
            ...slot,
            formattedTime: this._formatTime(slot.hora_disponible),
            formattedDate: this._formatDate(slot.fecha)
        };
    }

    /**
     * Find slots for a specific date.
     * @param {string} specialty 
     * @param {Date|string} date 
     */
    async findSlotsByDate(specialty, date) {
        log('info', `[AGENDA DOMAIN] Looking for slots for ${specialty} on ${date}`);
        const slots = await repo.getAvailabilityBySpecialty(specialty, date);
        return slots;
    }

    /**
     * Confirm an appointment.
     * @param {object} params
     * @param {string} params.rut
     * @param {import('./agenda.types.js').AppointmentSlot} params.slot
     * @param {string} params.sessionId
     */
    async confirmAppointment({ rut, slot, sessionId }) {
        log('info', `[AGENDA DOMAIN] Confirming appointment for RUT ${rut} on slot ${slot.id_disponibilidad}`);

        flowTrace({
            traceId: sessionId,
            layer: 'DOMAIN',
            flow: 'AGENDA',
            step: 'CONFIRM_APP',
            depth: 2,
            module: 'domains/agenda/agenda.domain.js',
            fn: 'confirmAppointment',
            action: 'INVOKE_REPO',
            result: 'START'
        });

        return repo.scheduleAppointment({
            patientIdOrRut: rut,
            fechaHora: slot.fecha, // Assuming fecha carries date+time or logic handles it
            especialidad: slot.especialidad,
            source: 'voicebot',
            sessionId
        });
    }

    /**
     * Release any held slots for this session.
     * @param {string} sessionId 
     */
    async releaseHold(sessionId) {
        return repo.releaseHeldSlot(sessionId);
    }

    _formatTime(dateObj) {
        if (!dateObj) return '';
        // If it's a string, try to parse or slice. If Date object, use valid methods.
        try {
            const d = new Date(dateObj);
            return d.toTimeString().slice(0, 5);
        } catch (e) {
            return String(dateObj);
        }
    }

    _formatDate(dateObj) {
        if (!dateObj) return '';
        try {
            const d = new Date(dateObj);
            return d.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
        } catch (e) {
            return String(dateObj);
        }
    }
}

export const agendaDomain = new AgendaDomain();
