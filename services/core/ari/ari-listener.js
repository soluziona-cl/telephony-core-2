import AriClient from "ari-client";
import { sql, poolPromise } from "../../../lib/db.js";
import redis from "../../../lib/redis.js";
import { log } from "../../../lib/logger.js";
import { checkRule } from "./business-rules.js";
import dotenv from "dotenv";
// cleaned legacy imports
import { startVoiceBotSessionV3 } from "../engine/voice-engine.js";
import { resolveClientCapsule } from "../../router/client-entry-router.js";
import { inboundConfig } from "../engine/config.js";
import { startRecording, stopRecording } from "../telephony/telephony-recorder.js";
dotenv.config();




// ------------------------------------------------------
// ⚙️ Configuración base
// ------------------------------------------------------
const APP = process.env.ARI_APP || "crm_app";

// === Guardas y helpers globales ===
const ORIGINATE_TIMEOUT_SEC = parseInt(process.env.ORIGINATE_TIMEOUT_SEC || "45", 10);
const RING_GUARD_MS = parseInt(process.env.RING_GUARD_MS || "2000", 10); // guard extra de 2s
const pendingGuards = new Map(); // linkedId -> timer

async function publishHangupOnce(channel, payload) {
  const id = payload.channelId || channel?.id;
  if (!id) return;
  const key = `hangup:${id}`;
  if (await redis.exists(key)) return;
  await redis.setEx(key, 15, "1"); // 15s anti-duplicado
  await publish(channel, "call.hangup", payload);
}

function mapAsteriskStateToReason(state) {
  // Mapea estados ARI a razones estándar
  switch (state) {
    case "Busy": return "busy";
    case "Congestion": return "congestion";
    case "Failed": return "no-route";
    case "Down": return "failed";
    default: return "unknown";
  }
}

// ------------------------------------------------------
// 🧩 Helpers
// ------------------------------------------------------
async function publish(channel, type, payload = {}) {
  try {
    await redis.publish(type, JSON.stringify(payload));
  } catch (e) {
    log("warn", `Redis publish error to ${type}`, e.message);
  }
}


// =====================================================
// 🛡️ VALIDACIÓN ANTIRRUIDO (Respiración/Micro abierto)
// =====================================================
async function isSuspectLowAudio(channel, attempt = 1) {
  try {
    // 1) Lectura de energía interna
    const energy = parseInt(channel?.variables?.CURRENT_ENERGY || "0");
    const talking = channel?.talking_at;
    const talkDetect = channel?.variables?.TALK_DETECT || "off";

    // === CASO: Primer intento → tolerancia ===
    if (attempt === 1) {
      // si energy baja pero hay micro abierto → reintentar
      if (energy < 50 || talkDetect === "off") {
        log("warn", `🤫 [VoiceBot] Audio débil en intento #1 → permitiendo reintento`);
        return { suspect: true, retry: true };
      }
    }

    // === CASO: Segundo intento → decisiones definitivas ===
    if (attempt === 2) {
      if (energy < 40 && talkDetect === "off") {
        log("warn", `❌ [VoiceBot] Silencio confirmado en intento #2 → abortando`);
        return { suspect: true, retry: false };
      }
    }

    // si energía ok
    if (energy > 60 || talkDetect === "on") {
      return { suspect: false, retry: false };
    }

    // fallback
    return { suspect: attempt === 1, retry: attempt === 1 };

  } catch (err) {
    log("error", `Error en isSuspectLowAudio(): ${err.message}`);
    return { suspect: false, retry: false };
  }
}



function detectDirection(channel) {
  const context = channel?.dialplan?.context || "";
  if (context.includes("from-trunk") || context.includes("public")) return "INBOUND";
  if (context.includes("from-internal") || context.includes("default")) return "OUTBOUND";
  if (context.includes("queue") || context.includes("support")) return "INBOUND";
  return "UNKNOWN";
}

// Crear bridge mixing si no existe
async function ensureBridge(ari, bridgeId) {
  const bridge = ari.Bridge();
  bridge.id = bridgeId;

  try {
    await bridge.create({ type: "mixing", name: "crm-bridge" });
    log("info", `🎧 Bridge ${bridgeId} creado (type: mixing)`);
  } catch (err) {
    if (err.message.includes("Bridge already exists")) {
      log("debug", `Bridge ${bridgeId} ya existente`);
    } else {
      log("warn", `Error creando bridge ${bridgeId}: ${err.message}`);
    }
  }

  return bridge;
}
// ==========================================================
// 🔍 Función robusta para parsear argumentos de Stasis
// Compatible con llamadas internas (crm_app) y externas.
// ==========================================================
function parseArgs(event, args) {

  // ARI recibe SOLO los parámetros después del app:
  // Stasis(crm_app, voicebot, 1003, 3000)
  // event.args = ["voicebot", "1003", "3000"]

  let raw = Array.isArray(args) && args.length ? args : (event.args || []);

  // Normalizar casos string
  if (typeof raw === "string") raw = [raw];

  // Si viene como un solo string con separadores
  if (raw.length === 1 && typeof raw[0] === "string") {
    const s = raw[0];
    if (s.includes(",")) raw = s.split(",");
    else if (s.includes(";")) raw = s.split(";");
  }

  // ⚠️ Forzar formato mínimo
  if (!Array.isArray(raw)) raw = [];
  if (raw.length < 1) raw = ["unknown"];

  // 🔥 Mapeo real:
  // raw[0] = mode
  // raw[1] = ANI
  // raw[2] = DNIS

  const mode = raw[0] || "unknown";
  const source = raw[1] || event.channel?.caller?.number || "UNKNOWN"; // ANI
  const target = raw[2] || event.channel?.dialplan?.exten || "UNKNOWN"; // DNIS

  return {
    mode,
    source: String(source).replace(/[^0-9+]/g, "") || "UNKNOWN",
    target: String(target).replace(/[^0-9+]/g, "") || "UNKNOWN",
    bridgeId: null,
    channelId: null,
    uniqueId: null
  };
}


async function setJson(key, obj, ex = 600) {
  await redis.set(key, JSON.stringify(obj), { EX: ex });
}
async function getJson(key) {
  const v = await redis.get(key);
  return v ? JSON.parse(v) : null;
}

// Mecanismo de lock para prevenir race conditions
async function acquireLock(lockKey, ttl = 10) {
  const lockValue = `${Date.now()}-${Math.random()}`;
  const result = await redis.set(lockKey, lockValue, { EX: ttl, NX: true });
  return result === "OK" ? lockValue : null;
}

async function releaseLock(lockKey, lockValue) {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  try {
    // ✅ CORRECCIÓN: Usar formato correcto de @redis/client
    return await redis.eval(script, {
      keys: [lockKey],
      arguments: [lockValue]
    });
  } catch (err) {
    log("error", `Error liberando lock ${lockKey}`, err.message);
    // ⚠️ Fallback: forzar eliminación del lock si el script falla
    try {
      await redis.del(lockKey);
      log("warn", `Lock ${lockKey} eliminado por fallback (no atómico)`);
    } catch { }
    return 0;
  }
}

// ------------------------------------------------------
// 🎯 Sistema de Detección Multinivel de Canales Relacionados
// ------------------------------------------------------
/**
 * 🎯 Detecta y fuerza hangup de canales relacionados usando múltiples métodos
 * @param {Object} ari - Cliente ARI
 * @param {string} linkedId - LinkedId de la llamada
 * @param {string} culpritId - ChannelId del canal que inició el hangup
 * @param {string} reason - Razón del hangup
 * @returns {Promise<string[]>} - Array de channelIds colgados
 */
async function findAndHangupRelatedChannels(ari, linkedId, culpritId, reason = "cancelled-by-origin") {
  const relatedChannels = [];
  const hangupPromises = [];

  try {
    // 🥇 NIVEL 1: RELACIÓN EXPLÍCITA A↔B (MÁS CONFIABLE)
    const bLegId = await redis.get(`aleg:${culpritId}:bleg`);
    const aLegId = await redis.get(`bleg:${culpritId}:aleg`);

    if (bLegId) {
      log("info", `🎯 Nivel 1: B-leg encontrado via relación explícita: ${bLegId}`);
      relatedChannels.push({ id: bLegId, source: "explicit-relation" });
    }

    if (aLegId) {
      log("info", `🎯 Nivel 1: A-leg encontrado via relación explícita: ${aLegId}`);
      relatedChannels.push({ id: aLegId, source: "explicit-relation" });
    }

    // 🥈 NIVEL 2: BÚSQUEDA POR BRIDGE (PARA CANALES EN BRIDGE)
    if (relatedChannels.length === 0) {
      const bridgeId = await redis.get(`bridge:${linkedId}`);
      if (bridgeId) {
        try {
          const bridge = ari.Bridge();
          bridge.id = bridgeId;
          const info = await bridge.get();

          if (Array.isArray(info.channels)) {
            const bridgeChannels = info.channels.filter(chId => chId !== culpritId);
            log("info", `🎯 Nivel 2: ${bridgeChannels.length} canal(es) encontrado(s) en bridge ${bridgeId}`);

            for (const chId of bridgeChannels) {
              relatedChannels.push({ id: chId, source: "bridge" });
            }
          }
        } catch (err) {
          if (!err.message.includes("not found")) {
            log("warn", `No se pudo acceder al bridge ${bridgeId}:`, err.message);
          }
        }
      }
    }

    // 🥉 NIVEL 3: BÚSQUEDA POR LINKEDID (FALLBACK LEGACY)
    if (relatedChannels.length === 0) {
      log("warn", `⚠️ Nivel 3: Fallback a búsqueda por linkedId para ${linkedId}`);
      try {
        const chans = await ari.channels.list();
        const linkedChans = chans.filter(ch =>
          (ch.linkedid === linkedId || ch.id === linkedId) && ch.id !== culpritId
        );

        for (const ch of linkedChans) {
          log("info", `🎯 Nivel 3: Canal encontrado por linkedId: ${ch.id}`);
          relatedChannels.push({ id: ch.id, source: "linkedid" });
        }
      } catch (err) {
        log("error", "Error listando canales en Nivel 3", err.message);
      }
    }

    // 🔨 EJECUTAR HANGUP DE TODOS LOS CANALES ENCONTRADOS
    for (const { id: chId, source } of relatedChannels) {
      log("info", `🧩 Forzando hangup de canal ${chId} (${reason}) [fuente: ${source}]`);

      hangupPromises.push(
        ari.channels.hangup({ channelId: chId })
          .then(() => {
            log("info", `✅ Hangup exitoso: ${chId}`);
            return chId;
          })
          .catch(err => {
            if (!err.message.includes("No such channel") && !err.message.includes("not found")) {
              log("warn", `⚠️ Error colgando canal ${chId}:`, err.message);
            }
            return chId; // Retornar de todas formas para publicar evento
          })
      );

      // Publicar evento de hangup
      await publishHangupOnce({ id: chId }, {
        channelId: chId,
        linkedId,
        ani: "",
        dnis: "",
        direction: "UNKNOWN",
        reason,
        endedAt: new Date().toISOString(),
      });

      // Marcar como procesado
      await redis.setEx(`hangup:${chId}`, 15, "1");
    }

    // Esperar a que todos los hangups terminen
    const hungUpChannels = await Promise.all(hangupPromises);

    if (relatedChannels.length === 0) {
      log("warn", `⚠️ No se encontraron canales relacionados para ${linkedId} (culprit: ${culpritId})`);
    } else {
      log("info", `✅ ${relatedChannels.length} canal(es) procesado(s) para hangup`);
    }

    return hungUpChannels;

  } catch (err) {
    log("error", "Error en findAndHangupRelatedChannels", err.message);
    return [];
  }
}

// ------------------------------------------------------
// 🧹 Limpieza y colgado cruzado
// ------------------------------------------------------
async function hangupOriginAndCleanup(ari, linkedId, culpritChannelId) {
  const lockKey = `cleanup:${linkedId}`;
  let lockValue = null;

  try {
    if (!lockValue) {
      log("debug", `🧹 Limpieza ya en progreso para ${linkedId} - saltando`);
      return;
    }

    log("info", `🧹 Iniciando limpieza para linkedId=${linkedId}, culprit=${culpritChannelId}`);

    // 🎯 USAR SISTEMA MULTINIVEL PARA ENCONTRAR CANALES
    const relatedChannels = await findAndHangupRelatedChannels(ari, linkedId, culpritChannelId, "cleanup");

    // 💥 DESTRUIR BRIDGE SI EXISTE
    const bridgeId = await redis.get(`bridge:${linkedId}`);
    if (bridgeId) {
      try {
        const b = ari.Bridge();
        b.id = bridgeId;
        await b.destroy();
        log("info", `💥 Bridge ${bridgeId} destruido`);
      } catch (err) {
        if (!err.message.includes("not found")) {
          log("debug", `Bridge ${bridgeId} ya destruido:`, err.message);
        }
      }
    }

    // 🧹 LIMPIEZA DE REDIS (extendida)
    const keysToDelete = [
      `bridge:${linkedId}`,
      `activeLinked:${linkedId}`,
      `channels:${linkedId}`,
      `aleg:${linkedId}`,
      `bridgeToLinked:${bridgeId}`,
    ];

    // Limpiar relaciones A↔B de los canales procesados
    for (const chId of [culpritChannelId, ...relatedChannels]) {
      keysToDelete.push(`aleg:${chId}:bleg`);
      keysToDelete.push(`bleg:${chId}:aleg`);
    }

    // Limpiar activeCall:* del linkedId
    const activeCallKeys = await redis.keys(`activeCall:*`);
    for (const key of activeCallKeys) {
      const data = await redis.get(key);
      if (data && data.includes(linkedId)) {
        keysToDelete.push(key);
      }
    }

    // Ejecutar limpieza en batch
    if (keysToDelete.length > 0) {
      await Promise.all(keysToDelete.map(key => redis.del(key).catch(() => { })));
      log("info", `🧹 Limpieza Redis: ${keysToDelete.length} keys eliminadas`);
    }

  } catch (e) {
    log("error", "hangupOriginAndCleanup error", e.message);
  } finally {
    if (lockValue) {
      try {
        await releaseLock(lockKey, lockValue);
      } catch (relErr) {
        log("error", `Error liberando lock ${lockKey}`, relErr.message);
        try { await redis.del(lockKey); } catch { }
      }
    }
  }
}

// ------------------------------------------------------
// 🔗 Conexión ARI
// ------------------------------------------------------
AriClient.connect(
  process.env.ARI_URL,
  process.env.ARI_USER,
  process.env.ARI_PASS,
  async (err, ari) => {
    if (err) {
      console.error("❌ Error al conectar con ARI:", err);
      return;
    }
    log("info", "✅ Conectado a Asterisk ARI");

    // ------------------------------------------------------
    // 🎬 STASIS START
    // ------------------------------------------------------
    ari.on("StasisStart", async (event, channel, args) => {

      log("error", "📦 DEBUG RAW ARGS", {
        args,
        eventArgs: event.args,
        typeArgs: typeof args,
        raw: JSON.stringify(args),
        eventArgsRaw: JSON.stringify(event.args)
      });

      // Parseo único, una sola vez
      const parsed = parseArgs(event, args);
      const mode = parsed.mode;
      const bridgeId = parsed.bridgeId || `bridge-${(channel.linkedid || channel.id)}`;
      const ani = parsed.source;
      const dnis = parsed.target;
      const linkedId = channel.linkedid || channel.id;

      // 🩹 fallback por si Asterisk aún envía "s"
      const safeDnis =
        dnis && dnis !== "s"
          ? dnis
          : (event.channel?.dialplan?.exten ||
            event.channel?.caller?.number ||
            event.channel?.connected?.number ||
            event.channel?.variables?.ORIG_EXT ||
            "UNKNOWN");

      try {
        // ==========================================================
        // 🧩 MODO INTERNO — llamadas entre extensiones
        // ==========================================================
        if (mode === "internal") {
          const safeAni = ani && ani !== "s" ? ani : (event.channel.caller?.number || "UNKNOWN");
          const safeDnis = dnis && dnis !== "s" ? dnis : (event.channel?.dialplan?.exten || "UNKNOWN");

          log("info", `📞 INTERNAL | ${safeAni} → ${safeDnis}`);

          // ------------------------------------------------------
          // 🧠 Validación de reglas de negocio (antes del IVR)
          // ------------------------------------------------------
          try {
            // 1️⃣ Verificar si está fuera de horario
            const inSchedule = await checkRule("schedule");
            if (!inSchedule) {
              log("info", `🕒 Llamada fuera de horario (${safeAni}) → desviando a IVR AfterHours`);
              await publish(channel, "rule.applied", {
                type: "afterhours",
                ani: safeAni,
                dnis: safeDnis,
                linkedId,
                timestamp: new Date().toISOString(),
              });

              // ✅ NUEVO: Publicar evento específico de rechazo
              await publish(channel, "call.rejected", {
                channelId: channel.id,
                linkedId,
                ani: safeAni,
                dnis: safeDnis,
                reason: "after-hours",
                direction: detectDirection(channel),
                endedAt: new Date().toISOString(),
              });

              // ✅ CORRECCIÓN: Colgar directo sin audio para evitar race condition
              try {
                await channel.hangup();
              } catch (err) {
                log("warn", "Error al colgar canal fuera de horario", err.message);
              }
              return;
            }

            // 2️⃣ Verificar si hoy es feriado
            const isHoliday = !(await checkRule("holiday"));
            if (isHoliday) {
              log("info", `🎉 Día feriado detectado, desviando a IVR AfterHours`);
              await publish(channel, "rule.applied", {
                type: "holiday",
                ani: safeAni,
                dnis: safeDnis,
                linkedId,
                timestamp: new Date().toISOString(),
              });

              // ✅ NUEVO: Publicar evento específico de rechazo
              await publish(channel, "call.rejected", {
                channelId: channel.id,
                linkedId,
                ani: safeAni,
                dnis: safeDnis,
                reason: "holiday",
                direction: detectDirection(channel),
                endedAt: new Date().toISOString(),
              });

              // ✅ CORRECCIÓN: Colgar directo sin audio para evitar race condition
              try {
                await channel.hangup();
              } catch (err) {
                log("warn", "Error al colgar canal en feriado", err.message);
              }
              return;
            }

            // 3️⃣ Verificar si es cliente VIP
            const isVip = await checkRule("vip", safeAni);
            if (isVip) {
              log("info", `⭐ Cliente VIP detectado (${safeAni})`);
              await publish(channel, "rule.applied", {
                type: "vip",
                ani: safeAni,
                dnis: safeDnis,
                linkedId,
                timestamp: new Date().toISOString(),
              });
              // Más adelante puedes enrutar a un IVR o cola prioritaria
            }
          } catch (ruleErr) {
            log("warn", "Error al aplicar reglas de negocio", ruleErr.message);
          }

          await channel.answer()
            .then(() => log("info", `✅ Canal origen (${channel.name}) contestado`))
            .catch(err => log("warn", "Error al contestar origen", err.message));

          // 🧱 Crear bridge para la llamada interna
          const bridge = await ensureBridge(ari, bridgeId);
          await bridge.addChannel({ channel: channel.id });

          // 🆕 NIVEL 1: Guardar A-leg en Redis ANTES de originate
          await redis.set(`bridge:${linkedId}`, bridgeId, { EX: 3600 });
          await redis.set(`activeLinked:${linkedId}`, bridgeId, { EX: 3600 });
          await setJson(`channels:${linkedId}`, { a: channel.id }, 3600);

          // 🆕 MAPEO INVERSO: bridgeId → linkedId (para búsqueda por bridge)
          await redis.set(`bridgeToLinked:${bridgeId}`, linkedId, { EX: 3600 });

          // 🆕 MAPEO A-LEG: linkedId → A-leg channelId
          await redis.set(`aleg:${linkedId}`, channel.id, { EX: 3600 });

          // 📡 Publicar evento de inicio de llamada (ringing)
          await publish(channel, "call.ringing", {
            channelId: channel.id,
            linkedId,
            ani: safeAni,
            dnis: safeDnis,
            direction: detectDirection(channel),
            state: "Ring",
            startedAt: new Date().toISOString(),
          });

          // 🚀 Originar canal destino (B-leg) con ANI y DNIS explícitos
          await ari.channels.originate({
            endpoint: `PJSIP/${safeDnis}`,
            app: APP,
            // 🆕 Enviamos bridgeId, ani, dnis escapando ; para que Asterisk mantenga la cadena completa
            appArgs: `bridge\\;${bridgeId}\\;${safeAni}\\;${safeDnis}`,
            callerId: safeAni,
            timeout: 45,
            context: "from-internal",
            extension: safeDnis,
            priority: 1,
          });

          // Guard: si el B-leg no llega a "Up" dentro del timeout + guard, limpiamos
          try {
            const guard = setTimeout(async () => {
              try {
                const chans = await ari.channels.list();
                const linkedChans = chans.filter(ch => (ch.linkedid || ch.id) === linkedId);

                if (linkedChans.length === 0) return; // ya se limpió

                // ✅ Solo timeout si NINGÚN canal llegó a "Up"
                const anyConnected = linkedChans.some(ch => ch.state === "Up");
                if (anyConnected) {
                  log("info", `🔗 Llamada conectada detectada (${linkedId}) - cancelando timeout`);
                  return; // No interrumpir llamadas activas
                }

                log("warn", `⏱️ Timeout de ring alcanzado (linkedId=${linkedId}) — forzando limpieza`);

                // Publica "timeout" para ambos extremos que sigan vivos
                for (const ch of linkedChans) {
                  await publishHangupOnce(ch, {
                    channelId: ch.id,
                    linkedId,
                    ani: ch?.caller?.number || "",
                    dnis: ch?.dialplan?.exten || "",
                    reason: "timeout",
                    direction: detectDirection(ch),
                    endedAt: new Date().toISOString(),
                  });
                  try { await ari.channels.hangup({ channelId: ch.id }); } catch { }
                }
                await hangupOriginAndCleanup(ari, linkedId, channel.id);
              } catch (e) {
                log("error", "Error en guard de timeout", e.message);
              } finally {
                pendingGuards.delete(linkedId);
              }
            }, (ORIGINATE_TIMEOUT_SEC * 1000) + RING_GUARD_MS);

            pendingGuards.set(linkedId, guard);
          } catch (e) {
            log("warn", "No se pudo instalar guard de timeout", e.message);
          }

          log("info", `🔗 Canal origen (${safeAni}) conectado, bridge ${bridge.id}`);

          channel.once("StasisEnd", async () => {
            await hangupOriginAndCleanup(ari, linkedId, channel.id);
          });
        }
        // else if (mode === "voicebot") {
        //   // ================ VOICEBOT ================
        //   if (!handleVoiceBot) {
        //     log("error", "❌ VoiceBot no disponible - módulos no cargados");
        //     try {
        //       await channel.hangup();
        //     } catch { }
        //     return;
        //   }

        //   log("info", `🤖 VoiceBot Session ANI=${ani} DNIS=${safeDnis}`);
        //   try {
        //     await channel.answer();
        //   } catch { }

        //   // Usar la función importada

        //   log("info", `🤖 Iniciando sesión de VoiceBot para canal ${ari} (${channel} → ${event.args}) ${linkedId}`);
        //   await handleVoiceBot(ari, channel, event.args, linkedId);
        //   return;
        // }

        else if (inboundConfig.bots[mode]) {
          const botConfig = inboundConfig.bots[mode];
          log("info", `🤖 [ARI] VoiceBot Session Mode=${mode} (${botConfig.description}) ANI=${ani} DNIS=${safeDnis}`);

          try { await channel.answer(); } catch { }

          // === HARD GATE DE 1 SEGUNDO PARA EVITAR FALSOS SILENCIOS ===
          const callStartTime = Date.now();

          // Esperamos un breve momento (protección) para asegurar que el canal esté listo
          // y no sea detectado como silencio inmediatamente.
          log("info", `🛡️ Protegiendo inicio de llamada para canal ${channel.id}, esperando 1000ms...`);
          await new Promise(r => setTimeout(r, 1000));

          const elapsed = Date.now() - callStartTime;
          log("info", `🛡️ Fin de protección para ${channel.id} (${elapsed}ms elapsed)`);

          // === VALIDACIÓN ANTIRRUIDO MULTINIVEL (DESHABILITADA) ===
          // El chequeo isSuspectLowAudio es poco confiable en ARI sin getVariable explícito.
          // Confiamos en el engine V3 para manejar el silencio durante la sesión.
          /*
          let check1 = await isSuspectLowAudio(channel, 1);
          if (check1.retry) {
            log("info", "🔁 Reintentando chequeo de audio en 300 ms...");
            await new Promise(r => setTimeout(r, 300));
            let check2 = await isSuspectLowAudio(channel, 2);
            if (check2.suspect) {
              log("warn", `❌ [VoiceBot] Sesión cancelada por silencio real tras 2 intentos`);
              await channel.hangup().catch(() => { });
              return;
            }
          }
          */

          // 🚀 Iniciar VoiceBot real
          // 🚀 Iniciar VoiceBot real (Arquitectura Unificada)
          log("info", `🤖 Iniciando sesión de VoiceBot (${mode}) para canal ${channel.id} (${ani} → ${safeDnis})`);

          try {
            const capsule = await resolveClientCapsule(mode);
            // Fix: Pass 'mode' as promptFile (string), not event.args (array)
            await startVoiceBotSessionV3(ari, channel, ani, dnis, linkedId, mode, {
              domain: capsule,
              mode: mode,
              botName: capsule ? 'Capsule' : 'Legacy'
            });
          } catch (err) {
            log("error", `❌ Error iniciando VoiceBot V3: ${err.message}`);
            await channel.hangup().catch(() => { });
          }
          return;
        }

        else if (mode === "bridge") {
          // **** ARREGLO CRÍTICO: usar bridgeId del parseo ****
          const bridge = await ensureBridge(ari, bridgeId);
          await channel.answer().catch(() => { });
          await bridge.addChannel({ channel: channel.id });

          // 🆕 NIVEL 1: Obtener linkedId del bridge mapping
          const linkedId = await redis.get(`bridgeToLinked:${bridgeId}`) || channel.linkedid || channel.id;

          log("info", `🔗 Canal ${channel.id} (${ani} → ${dnis}) unido a bridge ${bridgeId} [linkedId: ${linkedId}]`);

          // 🆕 COMPLETAR RELACIÓN A↔B
          const aLegId = await redis.get(`aleg:${linkedId}`);
          if (aLegId) {
            // Guardar relación bidireccional
            await redis.set(`aleg:${aLegId}:bleg`, channel.id, { EX: 600 });
            await redis.set(`bleg:${channel.id}:aleg`, aLegId, { EX: 600 });

            // Guardar en estructura de canales
            const chMap = (await getJson(`channels:${linkedId}`)) || {};
            chMap.b = channel.id;
            await setJson(`channels:${linkedId}`, chMap, 3600);

            log("info", `🔗 Relación establecida: A-leg=${aLegId} ↔ B-leg=${channel.id}`);
          } else {
            log("warn", `⚠️ No se encontró A-leg para linkedId ${linkedId}`);
          }

          // Actualizar bridge mapping
          await redis.set(`bridge:${linkedId}`, bridgeId, { EX: 600 });

          // 📡 Publicar estado de llamada para el B-leg
          await publish(channel, "call.state", {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            state: "Up",
            direction: detectDirection(channel),
            startedAt: new Date().toISOString(),
          });
        }
      } catch (e) {
        log("error", "Error en StasisStart", e.message);
      }
    });

    // ------------------------------------------------------
    // 🔄 ChannelStateChange
    // ------------------------------------------------------
    ari.on("ChannelStateChange", async (event, channel) => {
      try {
        const linkedId = channel.linkedid || channel.id;
        const ani = channel?.caller?.number || "";
        const dnis = channel?.dialplan?.exten || "";
        const state = channel.state;

        await setJson(`activeCall:${channel.id}`, {
          channelId: channel.id,
          linkedId,
          ani,
          dnis,
          state,
          lastUpdate: new Date().toISOString(),
        });

        if (state === "Ringing") {
          log("info", `🔔 Canal ${channel.id} (${ani} → ${dnis}) en Ringing`);
        } else if (state === "Up") {
          // 🧩 --- 1️⃣ Dirección dinámica ---
          const direction = detectDirection(channel);

          log("info", `🔗 Canal ${channel.id} (${ani} → ${dnis}) conectado [${direction}]`);

          // 📡 --- Publicar evento de estado ---
          await publish(channel, "call.state", {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            state: "Up",
            direction,
            startedAt: new Date().toISOString(),
          });

          // 🟢 --- Actualizar Redis ---
          await redis.set(`activeCall:${channel.id}`, JSON.stringify({
            channelId: channel.id,
            ani,
            dnis,
            state: "Up",
            linkedId,
            direction,
          }), { EX: 600 });

          // 🧩 --- Sincronizar canal hermano ---
          try {
            const chans = await ari.channels.list();
            for (const ch of chans) {
              if (ch.linkedid === linkedId && ch.id !== channel.id) {
                const otherAni = ch.caller?.number || "";
                const otherDnis = ch.dialplan?.exten || "";

                log("info", `🔄 Sincronizando canal hermano ${ch.id} (${otherAni} → ${otherDnis})`);

                await publish(ch, "call.state", {
                  channelId: ch.id,
                  linkedId,
                  ani: otherAni,
                  dnis: otherDnis,
                  state: "Up",
                  direction,
                  startedAt: new Date().toISOString(),
                });

                await redis.set(`activeCall:${ch.id}`, JSON.stringify({
                  channelId: ch.id,
                  ani: otherAni,
                  dnis: otherDnis,
                  state: "Up",
                  linkedId,
                  direction,
                }), { EX: 600 });
              }
            }
          } catch (syncErr) {
            log("warn", "Error al sincronizar canales hermanos", syncErr.message);
          }

          // 🟣 --- 2️⃣ Iniciar grabación usando servicio central ---
          try {
            const tenantId = channel?.variables?.TENANT_ID || channel?.variables?.TENANTID || process.env.DEFAULT_TENANT || "default";
            const { name: recName } = await startRecording(ari, channel, tenantId, linkedId, ani, dnis);
            if (recName) {
              await redis.set(`recording:${linkedId}`, recName, { EX: 3600 });
              log("info", `🎙️ Handle de grabación guardado en Redis: recording:${linkedId} -> ${recName}`);
            }
          } catch (err) {
            log("warn", "No se pudo iniciar grabación", err.message);
          }

          // ✅ --- Cancelar guard de timeout ---
          const guard = pendingGuards.get(linkedId);
          if (guard) {
            clearTimeout(guard);
            pendingGuards.delete(linkedId);
          }
        }

        // ❌ Estados de fallo (destino ocupado, sin ruta, etc.)
        const failStates = new Set(["Busy", "Congestion", "Failed", "Down"]);
        if (failStates.has(state)) {
          const reason = mapAsteriskStateToReason(state);
          log("info", `❌ Canal ${channel.id} fallo de llamada (${state}) → reason=${reason}`);

          await publishHangupOnce(channel, {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            reason,
            direction: detectDirection(channel),
            endedAt: new Date().toISOString(),
          });

          await hangupOriginAndCleanup(ari, linkedId, channel.id);
          return;
        }
      } catch (e) {
        log("warn", "Error en ChannelStateChange", e.message);
      }
    });

    // ------------------------------------------------------
    // ☎️ ChannelHangupRequest — Sistema Multinivel con Detección de Roles
    // ------------------------------------------------------
    ari.on("ChannelHangupRequest", async (event, channel) => {
      try {
        const linkedId = channel.linkedid || channel.id;
        const ani = channel?.caller?.number || "";
        const dnis = channel?.dialplan?.exten || "";
        const stateKey = `activeCall:${channel.id}`;
        const snapshot = await getJson(stateKey);
        const st = snapshot?.state || channel.state;

        // 🆕 DETECTAR ROL: A-leg o B-leg
        const bLegId = await redis.get(`aleg:${channel.id}:bleg`);
        const aLegId = await redis.get(`bleg:${channel.id}:aleg`);

        const isAleg = !!bLegId;
        const isBleg = !!aLegId;

        log("info", `📞 ChannelHangupRequest: ${channel.id} (ANI: ${ani}, DNIS: ${dnis}, State: ${st}, Role: ${isAleg ? 'A-leg' : isBleg ? 'B-leg' : 'Unknown'})`);

        // 🔴 CASO CRÍTICO: A-LEG CORTA (origen cancela)
        if (isAleg) {
          const reason = st === "Up" ? "caller-hangup" : "cancelled-before-answer";
          log("info", `🚨 A-leg (${ani}) colgó → forzando limpieza [reason: ${reason}]`);

          // Publicar hangup del A-leg
          await publishHangupOnce(channel, {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            reason,
            direction: detectDirection(channel),
            endedAt: new Date().toISOString(),
          });

          // 🎯 FORZAR HANGUP MULTINIVEL
          const lockKey = `forceHangup:${linkedId}`;
          const lockValue = await acquireLock(lockKey, 10);

          if (lockValue) {
            try {
              await findAndHangupRelatedChannels(ari, linkedId, channel.id, reason);
            } finally {
              await releaseLock(lockKey, lockValue);
            }
          }

          await hangupOriginAndCleanup(ari, linkedId, channel.id);
          return;
        }

        // 🔵 CASO: B-LEG CORTA (destino rechaza)
        if (isBleg) {
          log("info", `📞 B-leg (${dnis}) rechazó/colgó → notificando A-leg`);

          await publishHangupOnce(channel, {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            reason: "hangup-request",
            direction: detectDirection(channel),
            endedAt: new Date().toISOString(),
          });

          // No forzar hangup del A-leg, Asterisk lo maneja naturalmente
          return;
        }

        // 🟡 CASO GENÉRICO: Canal sin relación explícita (fallback)
        log("warn", `⚠️ Hangup de canal sin rol definido: ${channel.id}`);

        await publishHangupOnce(channel, {
          channelId: channel.id,
          linkedId,
          ani,
          dnis,
          reason: st === "Ringing" || st === "Ring" ? "cancelled-before-answer" : "hangup-request",
          direction: detectDirection(channel),
          endedAt: new Date().toISOString(),
        });

        // 🎯 Intentar limpieza multinivel de todas formas
        const lockKey = `forceHangup:${linkedId}`;
        const lockValue = await acquireLock(lockKey, 10);

        if (lockValue) {
          try {
            await findAndHangupRelatedChannels(ari, linkedId, channel.id, "hangup-request");
          } finally {
            await releaseLock(lockKey, lockValue);
          }
        }

      } catch (e) {
        log("error", "Error en ChannelHangupRequest", e.message);
      }
    });

    // ------------------------------------------------------
    // 📴 ChannelDestroyed — forzar corte de A-leg huérfano
    // ------------------------------------------------------
    ari.on("ChannelDestroyed", async (event, channel) => {
      try {
        const { id, caller } = channel;
        const ani = caller?.number || "UNKNOWN";

        // 🧩 Bonus: eliminar duplicados de call.hangup
        if (await redis.exists(`hangup:${id}`)) return;
        await redis.setEx(`hangup:${id}`, 10, '1');

        const linkedId = channel.linkedid || channel.id;
        const dnis = channel?.dialplan?.exten || "";
        const stateKey = `activeCall:${channel.id}`;
        const lastState = (await getJson(stateKey))?.state || channel.state;

        if (lastState === "Ringing" || lastState === "Ring") {
          log("info", `📞 ${ani} → ${dnis} cancelada antes de contestar`);
          await publish(channel, "call.cancelled", {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            cancelledAt: new Date().toISOString(),
          });
        }

        await hangupOriginAndCleanup(ari, linkedId, channel.id);

        // 🔹 Forzar corte manual si A-leg huérfano sigue activo
        try {
          const chans = await ari.channels.list();
          for (const ch of chans) {
            if (ch.caller?.number === ani && ch.id !== channel.id) {
              log("info", `🧩 Forzando hangup del A-leg huérfano (${ch.id}) de ${ani}`);
              try { await ari.channels.hangup({ channelId: ch.id }); } catch { }
            }
          }
        } catch (err) {
          log("warn", "No se pudo ejecutar hangup directo del A-leg:", err.message);
        }

        // 🎙️ --- Bloque de cierre de grabación ---
        try {
          const recName = await redis.get(`recording:${linkedId}`);
          if (recName && recName !== "undefined" && recName !== "null") {
            // 1️⃣ Intentar detener la grabación con manejo robusto
            try {
              await stopRecording(ari, recName);
              log("info", `🎙️ Grabación detenida correctamente (${recName})`);
            } catch (stopErr) {
              if (!stopErr.message.includes("not found") && !stopErr.message.includes("does not exist")) {
                log("warn", `Error deteniendo grabación ${recName}: ${stopErr.message}`);
              }
            }

            // 2️⃣ Construir ruta final estandarizada
            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, "0");
            const dd = String(now.getDate()).padStart(2, "0");
            const recordPath = `/opt/telephony-core/recordings/${yyyy}/${mm}/${dd}/${recName}.wav`;

            // 3️⃣ Guardar ruta en Redis (para watcher o n8n)
            await redis.set(`recordingPath:${linkedId}`, recordPath, { EX: 3600 });
            log("info", `💾 Ruta de grabación registrada: ${recordPath}`);

            // 4️⃣ Publicar actualización con ruta de grabación
            await publishHangupOnce(channel, {
              channelId: channel.id,
              linkedId,
              ani,
              dnis,
              reason: "channel-destroyed",
              recordingPath: recordPath,
              direction: detectDirection(channel),
              endedAt: new Date().toISOString(),
            });
          } else {
            // Fallback si no había grabación iniciada
            await publishHangupOnce(channel, {
              channelId: channel.id,
              linkedId,
              ani,
              dnis,
              reason: "channel-destroyed",
              direction: detectDirection(channel),
              endedAt: new Date().toISOString(),
            });
          }
        } catch (recErr) {
          log("error", "Error al finalizar grabación", recErr.message);
        }

        log("info", `💀 ChannelDestroyed detectado (${ani}) canal ${id}`);
      } catch (e) {
        log("error", "Error en ChannelDestroyed", e.message);
      }
    });

    // ------------------------------------------------------
    // 🧩 DETECTOR DE CORTE DEL ORIGEN (A-leg) - Mejorado con Detección Inmediata
    // ------------------------------------------------------
    ari.on("ChannelLeftBridge", async (event, channel) => {
      try {
        const { id, caller } = channel;
        const ani = caller?.number || "UNKNOWN";
        const bridgeId = event.bridge?.id;
        const linkedId = channel.linkedid || channel.id;

        log("info", `👋 Canal salió del bridge ${bridgeId || '(sin bridge)'}: ${ani} (${id})`);

        // 🆕 DETECTAR ROL
        const bLegId = await redis.get(`aleg:${id}:bleg`);
        const isAleg = !!bLegId;

        // 🚨 SI ES A-LEG: Forzar hangup del B-leg INMEDIATAMENTE
        if (isAleg && bLegId) {
          log("info", `🚨 A-leg salió del bridge → forzando hangup inmediato de B-leg ${bLegId}`);

          try {
            await ari.channels.hangup({ channelId: bLegId });

            await publishHangupOnce({ id: bLegId }, {
              channelId: bLegId,
              linkedId,
              ani: "",
              dnis: "",
              reason: "cancelled-by-origin",
              direction: "OUTBOUND",
              endedAt: new Date().toISOString(),
            });
          } catch (err) {
            if (!err.message.includes("No such channel")) {
              log("warn", `Error forzando hangup de B-leg ${bLegId}:`, err.message);
            }
          }
        }

        // 🧹 Publicar fin del canal actual
        const key = `activeCall:${id}`;
        const callData = await redis.get(key);
        if (callData) {
          const parsed = JSON.parse(callData);
          parsed.state = 'Hangup';
          parsed.reason = isAleg ? 'caller-hangup' : 'callee-hangup';
          parsed.endedAt = new Date().toISOString();
          await redis.publish('call.hangup', JSON.stringify(parsed));
          await redis.del(key);
        }

        // 🧹 Limpieza completa
        await hangupOriginAndCleanup(ari, linkedId, id);

        // 💥 Destruir bridge si existe
        if (bridgeId) {
          try {
            const b = ari.Bridge();
            b.id = bridgeId;
            await b.destroy();
            log("info", `💥 Bridge ${bridgeId} destruido tras salida`);
          } catch (err) {
            if (!err.message.includes("not found")) {
              log("debug", `Bridge ${bridgeId} ya destruido`);
            }
          }
        }

      } catch (err) {
        log("error", "Error manejando ChannelLeftBridge", err);
      }
    });

    // ==========================================
    // 🧩 BLOQUE FINAL — Corrección cortes cruzados
    // ==========================================
    async function forceHangupPair(ari, linkedId, culpritId, reason = "cancelled-by-origin") {
      const lockKey = `forceHangup:${linkedId}`;
      const lockValue = await acquireLock(lockKey, 10);

      if (!lockValue) {
        log("debug", `🧩 ForceHangupPair ya en progreso para ${linkedId} - saltando`);
        return;
      }

      try {
        // Anti-doble: verificar si ya se procesó este hangup
        if (await redis.exists(`hangup:${culpritId}`)) return;

        const chans = await ari.channels.list();
        const related = chans.filter(c => c.linkedid === linkedId && c.id !== culpritId);
        for (const ch of related) {
          log("info", `🧩 Forzando hangup cruzado del canal ${ch.id} (${reason})`);
          await ari.channels.hangup({ channelId: ch.id }).catch(() => { });
          await publishHangupOnce(ch, {
            channelId: ch.id,
            linkedId,
            ani: ch.caller?.number || "",
            dnis: ch.dialplan?.exten || "",
            direction: detectDirection(ch),
            reason,
            endedAt: new Date().toISOString(),
          });
          // Marcar como procesado para evitar dobles
          await redis.setEx(`hangup:${ch.id}`, 15, "1");
        }
      } catch (err) {
        log("warn", `Error en forceHangupPair(${linkedId})`, err.message);
      } finally {
        // Liberar el lock
        await releaseLock(lockKey, lockValue);
      }
    }

    // Captura hangup del origen
    ari.on("ChannelHangupRequest", async (event, channel) => {
      const linkedId = channel.linkedid || channel.id;
      const state = channel.state || "";
      const ani = channel.caller?.number;
      const isOrigin = ani && !channel.dialplan?.exten;

      if (isOrigin) {
        log("info", `📞 Origen (${ani}) colgó (${state})`);
        const reason = state === "Up" ? "caller-hangup" : "cancelled-before-answer";
        await forceHangupPair(ari, linkedId, channel.id, reason);
      }
    });

    // ------------------------------------------------------
    // 🔚 STASIS END
    // ------------------------------------------------------
    ari.on("StasisEnd", async (event, channel) => {
      const linkedId = channel.linkedid || channel.id;
      log("info", `🔚 Fin de llamada LinkedID=${linkedId} / Channel=${channel.id}`);

      // ✅ TRIGGER CAPA C: Transcripción Post-Call (Dual Transcription)
      try {
        await redis.publish('call.post_processing', JSON.stringify({
          linkedId,
          channelId: channel.id,
          ani: channel.caller?.number || "",
          dnis: channel.dialplan?.exten || "",
          timestamp: new Date().toISOString()
        }));
      } catch (e) {
        log("warn", "No se pudo notificar proceso post-call", e.message);
      }

      await hangupOriginAndCleanup(ari, linkedId, channel.id);
    });

    // ------------------------------------------------------
    // 🔄 Manejo de Reconexión ARI
    // ------------------------------------------------------
    ari.on('WebSocketReconnecting', (attempt) => {
      log("warn", `🔄 Reconectando WebSocket ARI (intento ${attempt})`);
    });

    ari.on('WebSocketMaxRetriesExceeded', () => {
      log("error", "❌ Máximos intentos de reconexión ARI excedidos - reiniciando servicio");
      process.exit(1);
    });

    ari.on('WebSocketConnected', () => {
      log("info", "✅ WebSocket ARI reconectado exitosamente");
    });

    ari.on('WebSocketDisconnected', () => {
      log("warn", "⚠️ WebSocket ARI desconectado - intentando reconexión automática");
    });

    // ------------------------------------------------------
    // 🚀 Iniciar App ARI
    // ------------------------------------------------------
    ari.start(APP);

    // ------------------------------------------------------
    // 🏥 Redis Healthcheck
    // ------------------------------------------------------
    setInterval(async () => {
      try {
        const testKey = "healthcheck:ari-listener";
        await redis.set(testKey, Date.now(), { EX: 10 });
        const val = await redis.get(testKey);
        if (!val) throw new Error("Redis no responde");
        log("debug", "🏥 Healthcheck OK");
      } catch (err) {
        log("error", "🏥 Healthcheck FAILED - Redis inaccesible", err.message);
      }
    }, 30000); // cada 30s

    // ------------------------------------------------------
    // 🧹 Orphan Lock Cleanup
    // ------------------------------------------------------
    setInterval(async () => {
      try {
        const keys = await redis.keys("cleanup:*");
        const now = Date.now();

        for (const key of keys) {
          const ttl = await redis.ttl(key);
          if (ttl === -1) { // Lock sin TTL (huérfano)
            log("warn", `🧹 Lock huérfano detectado: ${key}, eliminando`);
            await redis.del(key);
          }
        }

        if (keys.length > 0) {
          log("debug", `🧹 Orphan cleanup: ${keys.length} locks verificados`);
        }
      } catch (err) {
        log("error", "Error en orphan lock cleanup", err.message);
      }
    }, 300000); // cada 5 minutos

    // ------------------------------------------------------
    // 📊 Métricas de Sistema Multinivel
    // ------------------------------------------------------
    setInterval(async () => {
      try {
        // Contar relaciones A↔B activas
        const alegKeys = await redis.keys("aleg:*:bleg");
        const blegKeys = await redis.keys("bleg:*:aleg");

        // Contar bridges activos
        const bridgeKeys = await redis.keys("bridge:*");

        // Contar canales activos
        const activeCallKeys = await redis.keys("activeCall:*");

        log("info", `📊 Métricas Sistema: A↔B=${alegKeys.length}, Bridges=${bridgeKeys.length}, Canales=${activeCallKeys.length}`);

        // Detectar posibles problemas
        if (alegKeys.length > 50) {
          log("warn", `⚠️ Alto número de relaciones A↔B: ${alegKeys.length}`);
        }

        if (activeCallKeys.length > 100) {
          log("warn", `⚠️ Alto número de canales activos: ${activeCallKeys.length}`);
        }

      } catch (err) {
        log("error", "Error en métricas de sistema", err.message);
      }
    }, 60000); // cada 1 minuto
  }
);

