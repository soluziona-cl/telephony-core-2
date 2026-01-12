// =========================================================
// VOICEBOT ENGINE V3 - WITH DB QUERY (PROTOTYPE v0)
// Nuevo flujo: pedir RUT, validar, buscar paciente, preguntar especialidad, consultar disponibilidad.
// =========================================================

import fs from 'fs';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { OpenAIRealtimeClientV3 } from '../shared/openai-realtime-client-v3.js';
import { log } from '../../../lib/logger.js';
import { inboundConfig as config } from './voicebot-config-inbound.js';
import { buildPrompt } from '../shared/prompt-builder.js';
import { getPatientByRut, getPatientByAni, getNextAppointment, getAvailabilityBySpecialty, scheduleAppointment } from '../shared/db-queries.js';
import { extractRutFromText, normalizeRut, isValidRut, maskRut, calcularEdad } from '../shared/utils.js';

const execAsync = promisify(exec);
const VOICEBOT_PATH = config.paths.voicebot;
const ASTERISK_REC_PATH = config.paths.recordings;

async function convertWavToWav8000(inputWav, outputWav) {
  try {
    const cmd = `ffmpeg -y -i "${inputWav}" -ar 8000 -ac 1 -codec:a pcm_mulaw "${outputWav}"`;
    log('debug', `[FFmpeg] ${cmd}`);
    await execAsync(cmd);
  } catch (err) {
    throw new Error(`FFmpeg conversion failed: ${err.message}`);
  }
}

async function synthAndPlayText(openaiClient, ari, channel, text) {
  try {
    const audioBuffer = await openaiClient.sendTextAndWait(text);
    if (!audioBuffer || !audioBuffer.length) {
      log('warn', 'synthAndPlayText: audio vacío');
      return false;
    }

    const rspId = `vb_tmp_${Date.now()}`;
    const rawPcmFile = `/tmp/${rspId}.pcm`;
    const finalWavFile = `${VOICEBOT_PATH}/${rspId}.wav`;

    fs.writeFileSync(rawPcmFile, audioBuffer);

    const cmd = `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmFile}" -ar 8000 -ac 1 -c:a pcm_s16le "${finalWavFile}"`;
    log('debug', `[FFmpeg] ${cmd}`);
    await execAsync(cmd);

    // Reproducir directamente (sin manejo avanzado de barge-in en esta PR)
    const media = `sound:voicebot/${rspId}`;
    const playback = ari.Playback();
    await channel.play({ media }, playback);
    return true;
  } catch (err) {
    log('error', `synthAndPlayText error: ${err.message}`);
    return false;
  }
}

async function recordAndTranscribe(channel, turnNote = '') {
  const recId = `vb_q_${Date.now()}`;
  const wavFile = `${ASTERISK_REC_PATH}/${recId}.wav`;

  log('info', `🎙️ [VB Q] Grabando respuesta (${turnNote}) -> ${recId}`);

  let recordingObj;
  try {
    recordingObj = await channel.record({
      name: recId,
      format: 'wav',
      beep: false,
      maxSilenceSeconds: config.audio.maxSilenceSeconds,
      silenceThreshold: config.audio.silenceThreshold,
      ifExists: 'overwrite'
    });
  } catch (err) {
    log('error', `recordAndTranscribe start error: ${err.message}`);
    return { ok: false };
  }

  const result = await new Promise((resolve) => {
    let finished = false;
    recordingObj.on('RecordingFinished', () => {
      if (finished) return;
      finished = true;
      resolve({ ok: true, path: wavFile });
    });

    recordingObj.on('RecordingFailed', (evt) => {
      if (finished) return;
      finished = true;
      log('error', `RecordingFailed: ${JSON.stringify(evt)}`);
      resolve({ ok: false });
    });

    // Timeout safety
    setTimeout(() => {
      if (!finished) {
        try { recordingObj.stop().catch(()=>{}); } catch(e){}
      }
    }, config.audio.maxRecordingMs + 500);
  });

  if (!result.ok) return result;

  const exists = fs.existsSync(result.path);
  if (!exists) {
    log('error', `Archivo no encontrado: ${result.path}`);
    return { ok: false };
  }

  // Convertir y pedir transcripción usando OpenAI (ejecutante deberá enviar audio para transcripción)
  // Devolvemos la ruta para que el llamador lo convierta y llame al openai client si lo necesita.
  return { ok: true, path: result.path };
}

/** Flujo principal: pide RUT, valida, busca paciente, pregunta especialidad y disponibilidad */
export async function startVoiceBotSessionWithQuery(ari, channel, ani, dnis, linkedId, promptFile) {
  log('info', `🤖[VB Q] Iniciando sesión con Query ANI=${ani} DNIS=${dnis} Prompt=${promptFile}`);

  // Resolver si el prompt/bot necesita acceso a BDD (más flexible)
  function promptRequiresDb(promptFileName) {
    try {
      const bots = config.bots || {};
      for (const key of Object.keys(bots)) {
        const b = bots[key];
        if (b && b.prompt === promptFileName) return !!b.requiresDb;
      }
    } catch (e) {
      // ignore and fallback
    }
    return false;
  }

  const necesitaBDD = promptRequiresDb(promptFile) ? 'sí' : 'no';

  const systemPrompt = buildPrompt(
    promptFile,
    { ANI: ani, DNIS: dnis, FechaHoy: new Date().toLocaleDateString('es-CL'), NecesitaBDD: necesitaBDD },
    'inbound'
  );

  const openaiClient = new OpenAIRealtimeClientV3({
    voice: config.openai.voice,
    language: config.openai.language,
    model: config.openai.model,
    instructions: systemPrompt
  });

  try {
    await openaiClient.connect();
  } catch (err) {
    log('error', `OpenAI connect failed: ${err.message}`);
    return;
  }

  // SALUDO
  await synthAndPlayText(openaiClient, ari, channel, 'Hola, soy Sofía del Consultorio de Quinteros.');

  // Preguntar RUT y validar (máx 3 intentos)
  let rutValid = null;
  for (let attempt = 0; attempt < 3 && !rutValid; attempt++) {
    await synthAndPlayText(openaiClient, ari, channel, 'Por favor, indícame tu RUT con puntos y guión si lo tienes.');
    const rec = await recordAndTranscribe(channel, `RUT intento ${attempt + 1}`);
    if (!rec.ok) {
      log('warn', 'record failed, intentando de nuevo');
      continue;
    }

    // Convertir y enviar audio para transcripción
    const processed = `/tmp/vb_proc_${Date.now()}_8k.wav`;
    try {
      await convertWavToWav8000(rec.path, processed);
      await openaiClient.sendAudioAndWait(processed);
    } catch (err) {
      log('error', `transcription failed: ${err.message}`);
      continue;
    }

    const transcript = openaiClient.lastTranscript;
    log('info', `Transcription: ${transcript}`);

    const extracted = extractRutFromText(transcript);
    if (!extracted) {
      await synthAndPlayText(openaiClient, ari, channel, 'No pude reconocer un RUT. ¿Puedes repetirlo, por favor?');
      continue;
    }

    const normalized = normalizeRut(extracted);
    const isValid = isValidRut(normalized);
    if (!isValid) {
      await synthAndPlayText(openaiClient, ari, channel, 'El RUT no parece válido. Por favor verifica y repítelo.');
      continue;
    }

    rutValid = normalized;
    log('info', `RUT validado: ${maskRut(rutValid)}`);
  }

  if (!rutValid) {
    await synthAndPlayText(openaiClient, ari, channel, 'No pude validar tu RUT, te conecto con un ejecutivo.');
    // Enviar frase exacta para transferencia (política del prompt)
    // Aquí se podría activar transferencia a cola
    return;
  }

  // Buscar paciente en DB
  const patient = await getPatientByRut(rutValid);
  if (!patient) {
    await synthAndPlayText(openaiClient, ari, channel, 'No encontré el RUT en el sistema. ¿Quieres que lo verifique con un ejecutivo?');
    return;
  }

  const edad = patient.edad || null;
  const nombre = patient.nombre_completo || 'cliente';

  await synthAndPlayText(openaiClient, ari, channel, `He encontrado a ${nombre}. ¿Es correcto?`);
  // Grabar confirmación
  const confRec = await recordAndTranscribe(channel, 'confirmacion nombre');
  if (!confRec.ok) {
    await synthAndPlayText(openaiClient, ari, channel, 'No pude escuchar una confirmación, te transferiré a un ejecutivo.');
    return;
  }
  try {
    const p8 = `/tmp/vb_conf_${Date.now()}_8k.wav`;
    await convertWavToWav8000(confRec.path, p8);
    await openaiClient.sendAudioAndWait(p8);
  } catch (err) {
    log('error', `error procesando confirmacion: ${err.message}`);
    return;
  }

  const confTranscript = openaiClient.lastTranscript || '';
  const affirmative = /(si|sí|correcto|afirmo|si es|si es correcto)/i.test(confTranscript);
  if (!affirmative) {
    await synthAndPlayText(openaiClient, ari, channel, 'Entiendo. Te transferiré a un ejecutivo para que actualice los datos.');
    return;
  }

  // Inyectar datos confirmados al asistente para el resto de la sesión
  try {
    const esAdultoMayor = edad && edad >= 60 ? 'sí' : 'no';
    await openaiClient.sendSystemText(`Paciente confirmado: Nombre=${nombre}, Edad=${edad || 'desconocida'}, EsAdultoMayor=${esAdultoMayor}, Rut=${rutValid}`);
    if (edad && edad >= 60) {
      await openaiClient.sendSystemText('ADULTOS MAYORES: Usa frases más cortas y claras; repite la información importante y pregunta si necesita que se la repitas.');
    }
  } catch (err) {
    log('warn', `⚠️ [VB Q] No se pudo inyectar datos del paciente: ${err.message}`);
  }

  // Preguntar especialidad
  await synthAndPlayText(openaiClient, ari, channel, '¿Qué especialidad necesita?');
  const specRec = await recordAndTranscribe(channel, 'especialidad');
  if (!specRec.ok) {
    await synthAndPlayText(openaiClient, ari, channel, 'No te escuché, por favor intenta nuevamente o contacta a un ejecutivo.');
    return;
  }
  try {
    const p9 = `/tmp/vb_spec_${Date.now()}_8k.wav`;
    await convertWavToWav8000(specRec.path, p9);
    await openaiClient.sendAudioAndWait(p9);
  } catch (err) {
    log('error', `error transcribing specialty: ${err.message}`);
    return;
  }
  const specialtyTranscript = openaiClient.lastTranscript || '';
  const specialty = specialtyTranscript.trim();

  // Buscar disponibilidades (hoy y siguientes 7 días) adaptadas a CLI_QUINTEROS_disponibilidad_horas
  const today = new Date();
  let foundSlot = null;
  for (let i = 0; i < 7 && !foundSlot; i++) {
    const day = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
    const dateStr = day.toISOString().slice(0, 10);
    const slots = await getAvailabilityBySpecialty(specialty, dateStr);
    if (slots && slots.length > 0) {
      // slots are rows with hora_disponible (time) and doctor_box
      foundSlot = { date: dateStr, slot: slots[0] };
      break;
    }
  }

  if (!foundSlot) {
    await synthAndPlayText(openaiClient, ari, channel, `No encontré cupos disponibles para ${specialty} en los próximos días. ¿Deseas que te contacte un ejecutivo para ver opciones?`);
    return;
  }

  // Proponer primer slot
  const slotTime = foundSlot.slot.hora_disponible ? foundSlot.slot.hora_disponible.slice(0,5) : '';
  const slotText = `${foundSlot.date} a las ${slotTime} (${foundSlot.slot.doctor_box || ''})`;
  await synthAndPlayText(openaiClient, ari, channel, `Hay un cupo disponible el ${slotText}. ¿Desea que lo agende?`);

  const agRec = await recordAndTranscribe(channel, 'confirmacion agendamiento');
  if (!agRec.ok) {
    await synthAndPlayText(openaiClient, ari, channel, 'No entendí la confirmación. Por favor contacte a un ejecutivo para agendar.');
    return;
  }
  try {
    const p10 = `/tmp/vb_ag_${Date.now()}_8k.wav`;
    await convertWavToWav8000(agRec.path, p10);
    await openaiClient.sendAudioAndWait(p10);
  } catch (err) {
    log('error', `error transcribing confirmacion agendar: ${err.message}`);
    return;
  }

  const agTranscript = openaiClient.lastTranscript || '';
  const agAffirm = /(si|sí|confirmo|sí, por favor|ok|adelante)/i.test(agTranscript);
  if (!agAffirm) {
    await synthAndPlayText(openaiClient, ari, channel, 'Entendido. No se agendó nada. ¿Deseas que te conecte con un ejecutivo?');
    return;
  }

  // Intentar agendar en BD
  const scheduled = await scheduleAppointment(patient.PatientId, new Date(foundSlot.slot.FechaHora), specialty, 'voicebot_quintero');
  if (scheduled && scheduled.ok) {
    await synthAndPlayText(openaiClient, ari, channel, `Perfecto, tu cita fue agendada para el ${slotText}. Tu número de reserva es ${scheduled.id}.`);
  } else {
    log('error', `Error agendando cita: ${JSON.stringify(scheduled)}`);
    await synthAndPlayText(openaiClient, ari, channel, `Lo siento, no pude agendar la cita en este momento. ¿Deseas que te conecte con un ejecutivo para terminar el proceso?`);
  }

  openaiClient.disconnect();
  log('info', `🔚[VB Q] Flujo completado para RUT ${maskRut(rutValid)} (paciente: ${nombre})`);
    // Cierre adicional para balancear llaves abiertas (corregir SyntaxError: Unexpected end of input)
}

export default startVoiceBotSessionWithQuery;
