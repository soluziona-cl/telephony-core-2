/**
 * LEGACY BUSINESS LOGIC
 * (Moved from voice-engine.js for cleanup)
 * 
 * Contains complex state machine logic for legacy RUT capture and confirmation.
 * This is "Hard State Machine" logic that logic that will eventually be replaced
 * by domain-specific capsules.
 */

import { log } from "../../../../lib/logger.js";
import { normalizeRut, isValidRut, maskRut, parseRutFromSpeech, cleanAsrNoise, extractRutHard, formatRut } from "../utils.js";
import { classifyConfirmSimple } from "../legacy-compat/confirm-classifier.js";
import { extractRutCandidate } from "./legacy-helpers.js";
import { shouldTransferToQueue, transferToQueue } from "../domain/transfers.js";
import { inboundConfig as config } from "../config.js";
import { classifyInput } from "../legacy-compat/openai-classifier.js";
import { getAndHoldNextSlot, scheduleAppointment, getPatientByRut } from "../legacy-compat/db-queries.js";

const QUEUES_NAME = config.queues.nameQueue;

// Helper moved from voice-engine.js
export function detectSpecialty(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    const specialties = [
        { key: "Medicina General", synonyms: ["medicina general", "médico general", "doctor general", "medicina"] },
        { key: "Odontología", synonyms: ["odontología", "dentista", "odontólogo", "odontologo", "dientes"] },
        { key: "Pediatría", synonyms: ["pediatría", "pediatra", "niños", "niño", "niña"] },
        { key: "Matrona", synonyms: ["matrona", "obstetricia", "embarazo"] },
        { key: "Kinesiología", synonyms: ["kinesiología", "kinesiólogo", "kinesióloga", "kinesis", "ejercicios"] },
        { key: "Nutricionista", synonyms: ["nutricionista", "nutrición", "dieta", "peso"] },
        { key: "Psicología", synonyms: ["psicología", "psicólogo", "psicóloga", "terapia"] },
        { key: "Enfermería", synonyms: ["enfermería", "enfermero", "enfermera", "curaciones", "vacunas"] },
        { key: "Oftalmología", synonyms: ["oftalmología", "oftalmólogo", "vista", "ojos"] },
        { key: "Ginecología", synonyms: ["ginecología", "ginecólogo", "mujer"] },
        { key: "Cardiología", synonyms: ["cardiología", "cardiólogo", "corazón", "corazon"] },
        { key: "Dermatología", synonyms: ["dermatología", "dermatólogo", "piel"] }
    ];

    for (const s of specialties) {
        for (const syn of s.synonyms) {
            if (lower.includes(syn)) return s.key;
        }
    }
    return null;
}




/**
 * 🧠 Lógica de Negocio General (Normal Mode)
 * Maneja Agenda, Transferencias y Detección de intención de RUT
 */
export async function runBusinessLogic(transcript, assistantResponse, businessState, conversationState, ari, channel, openaiClient, linkedId) {
    const cleanTranscript = (transcript || "").toLowerCase();

    // 1. Detección de Intención de dar RUT (si estamos en 'NONE')
    // Si el usuario dice "mi rut es...", "tengo hora", "quiero pedir hora" -> activamos RUT flow
    if (businessState.rutPhase === 'NONE') {
        const intentionKeywords = ['rut', 'carnet', 'identidad', 'hora', 'medico', 'doctor', 'cita', 'agendar', 'horas'];
        const hasIntention = intentionKeywords.some(w => cleanTranscript.includes(w));

        // También si detectamos un número largo tipo RUT
        const rutCandidate = extractRutCandidate(cleanTranscript);

        if (hasIntention || rutCandidate.body) {
            log("info", `💡 [LOGIC] Intención detectada. Activando RUT Flow.`);
            if (rutCandidate.body) {
                // Si ya dio el cuerpo, lo guardamos y pasamos directo a WAIT_DV
                businessState.rutBody = rutCandidate.body;
                businessState.rutPhase = 'WAIT_DV'; // Próximo turno será Strict Mode WAIT_DV
            } else {
                businessState.rutPhase = 'WAIT_BODY';
            }
        }
    }

    // 2. Detección de Especialidad y Agenda (Solo si ya tenemos DNI identificado o estamos en flujo libre)
    // MEJORADO: Detectar intención explícita "quiero hora" o implícita (solo especialidad)
    const explicitAgenda = ['hora', 'cita', 'agendar', 'ver', 'reservar'].some(w => cleanTranscript.includes(w));
    const detectedSpecialty = detectSpecialty(cleanTranscript);

    // Si detectamos especialidad (nueva) o tenemos una pendiente (businessState.specialty) pero no slot reservado
    const activeSpecialty = detectedSpecialty || businessState.specialty;
    const isBookingIntent = (detectedSpecialty && (explicitAgenda || !businessState.heldSlot)) || (businessState.specialty && explicitAgenda);

    if (activeSpecialty && isBookingIntent && !businessState.heldSlot) {
        businessState.specialty = activeSpecialty;
        log('info', `🎯 [AGENDA] Intención de agendar para: ${activeSpecialty}`);

        // 🧠 CLASIFICACIÓN DE INTENCIÓN DE FECHA
        const dateClass = await classifyInput({
            phase: 'DATE_INTENT',
            userText: cleanTranscript
        });

        let dateType = 'UNKNOWN';
        let specificDate = null;

        if (dateClass.ok && dateClass.result) {
            dateType = dateClass.result.date_type;
            specificDate = dateClass.result.date;
            log('info', `🧠 [CLASSIFIER] DATE_INTENT: ${dateType} (${specificDate})`);
        }

        if (dateType === 'NEXT_AVAILABLE' || (dateType === 'UNKNOWN' && detectedSpecialty)) {
            // Caso 1: "La más próxima" o default (si acaba de decir la especialidad, asumimos próxima)

            // 🎯 EVENTO 3: DELEGAR GET_NEXT_AVAILABILITY AL WEBHOOK
            const rutFormatted = businessState.dni || businessState.rutFormatted || (businessState.rutBody && businessState.rutDv ? `${businessState.rutBody}-${businessState.rutDv}` : null);

            if (!rutFormatted || !rutFormatted.includes('-')) {
                log('warn', `⚠️ [AGENDA] No hay RUT válido para buscar disponibilidad`);
                await openaiClient.sendSystemText(
                    `SISTEMA: Primero necesito validar su RUT. Por favor, indíqueme su RUT completo.`
                );
            } else {
                log('info', `🗓️ [AGENDA] Buscando PRÓXIMA DISPONIBLE para ${activeSpecialty}`);
                const slot = await getAndHoldNextSlot(activeSpecialty, linkedId);

                if (slot) {
                    businessState.heldSlot = slot;
                    const slotTime = slot.hora_disponible ? slot.hora_disponible.toString().slice(0, 5) : '';
                    const slotDate = slot.fecha ? new Date(slot.fecha).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
                    const doctor = slot.doctor_box || 'un especialista';

                    await openaiClient.sendSystemText(
                        `SISTEMA: Cupo reservado: ${activeSpecialty} con ${doctor} el ${slotDate} a las ${slotTime}. Pregunta si confirma.`
                    );
                } else {
                    log('warn', `⚠️ [AGENDA] Sin cupos próximos para ${activeSpecialty}`);
                    await openaiClient.sendSystemText(
                        `SISTEMA: No hay horas disponibles para ${activeSpecialty}. Informa y ofrece otra opción.`
                    );
                }
            }
        }
        else if (dateType === 'EXACT_DATE' && specificDate) {
            // Caso 2: Fecha específica ("El lunes", "El 3 de enero")
            log('info', `🗓️ [AGENDA] Buscando para FECHA EXACTA: ${specificDate}`);

            const slots = await import('../legacy-compat/db-queries.js').then(m => m.getAvailabilityBySpecialty(activeSpecialty, specificDate));

            if (slots && slots.length > 0) {
                // Tomamos la primera para ofrecer
                const first = slots[0];
                const time = first.hora_disponible.toISOString().split('T')[1].slice(0, 5);
                await openaiClient.sendSystemText(
                    `SISTEMA: Para el ${specificDate} tengo hora a las ${time} con ${first.doctor_box}. ¿Le sirve?`
                );
                businessState.heldSlot = {
                    id_disponibilidad: first.id_disponibilidad,
                    fecha: first.fecha,
                    hora_disponible: first.hora_disponible,
                    especialidad: first.especialidad,
                    doctor_box: first.doctor_box,
                    requisito: first.requisito
                };
            } else {
                await openaiClient.sendSystemText(
                    `SISTEMA: No quedan horas para el ${specificDate}. Pregunta si quiere ver la fecha más próxima disponible.`
                );
            }
        }
        else {
            // Caso 3: UNKNOWN (y no es solo especialidad, es algo raro)
            log('info', `❓ [AGENDA] Intención de fecha desconocida o ambigua.`);
            await openaiClient.sendSystemText(
                `SISTEMA: El usuario quiere ${activeSpecialty} pero no entendí para cuándo. Pregunta: ¿Para cuándo necesita la hora?`
            );
        }
    }


    // 3. Confirmación (HOLD -> OCUPADO)
    if (businessState.heldSlot && (cleanTranscript.includes("si") || cleanTranscript.includes("confirmo"))) {
        const slot = businessState.heldSlot;
        const result = await scheduleAppointment(businessState.dni || 'SIN_RUT', new Date(slot.fecha), businessState.specialty, 'voicebot', linkedId);
        if (result.ok) {
            await openaiClient.sendSystemText(`SISTEMA: Cita confirmada ID ${result.id}. Despídete.`);
            businessState.heldSlot = null;
        }
    }

    // 4. Transferencia semántica
    if (shouldTransferToQueue(transcript, assistantResponse)) {
        log("info", `📞 [LOGIC] Transferencia semántica detectada.`);
        await transferToQueue(ari, channel, QUEUES_NAME || "cola_ventas");
        conversationState.active = false;
    }
}

