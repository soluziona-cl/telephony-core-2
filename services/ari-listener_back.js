import AriClient from "ari-client";
import { sql, poolPromise } from "../lib/db.js";
import redis from "../lib/redis.js";
import { log } from "../lib/logger.js";
import { checkRule } from "./business-rules.js";
import dotenv from "dotenv";
dotenv.config();

// ------------------------------------------------------
// ⚙️ Configuración base
// ------------------------------------------------------
const APP = process.env.ARI_APP || "crm_app";

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

// ==========================================================
// 🔍 Función robusta para parsear argumentos de Stasis
// Compatible con llamadas internas (crm_app) y externas.
// ==========================================================
function parseArgs(event, args) {
  // Asterisk puede enviar los args como array o string con comas
  let raw = Array.isArray(args) && args.length ? args : (event.args || []);
  
  // 🩹 Manejar escapes de punto y coma antes del parsing
  if (typeof raw === "string") {
    raw = raw.replace(/\\;/g, ";"); // eliminar escapes antes de split
  }
  
  let mode = null, source = null, target = null, bridgeId = null, channelId = null, uniqueId = null;

  if (raw.length) {
    // Ejemplo: Stasis(crm_app, internal, 1002, 1001, PJSIP/1002-000001, 1761157...)
    if (raw[0] === "bridge") {
      mode = "bridge";
      bridgeId = raw[1];
    } else if (raw.length >= 5) {
      [mode, source, target, channelId, uniqueId] = raw;
    } else if (raw.length >= 3) {
      [mode, source, target] = raw;
    } else if (typeof raw[0] === "string") {
      if (raw[0].includes(";")) {
        // 🆕 Manejar argumentos separados por punto y coma (bridge;id;ani;dnis)
        const parts = raw[0].split(";");
        if (parts.length >= 4) {
          [mode, bridgeId, source, target] = parts;
        } else if (parts.length >= 3) {
          [mode, source, target] = parts;
        }
      } else if (raw[0].includes(",")) {
        // 🔄 Mantener compatibilidad con comas
        [mode, source, target] = raw[0].split(",");
      } else {
        mode = raw[0];
      }
    } else {
      mode = raw[0];
    }
  }

  // ==========================================================
  // 🩹 Corrección de DNIS y ANI para evitar valores "s" o vacíos
  // ==========================================================
  if (!target || target === "s" || target === "null" || target.trim() === "") {
    target =
      event.channel?.dialplan?.exten ||                      // extensión del dialplan
      event.channel?.caller?.number ||                       // número del llamante
      event.channel?.connected?.number ||                    // número conectado
      event.channel?.variables?.ORIG_EXT ||                  // variable heredada del dialplan
      "UNKNOWN";
  }

  if (!source || source === "s" || source === "null" || source.trim() === "") {
    source =
      event.channel?.caller?.number ||                       // llamante directo
      event.channel?.connected?.number ||                    // número remoto
      event.channel?.variables?.CALLERID(num) ||             // variable explícita
      "UNKNOWN";
  }

  // ==========================================================
  // 🔁 Normalización de strings (por seguridad)
  // ==========================================================
  source = String(source).replace(/[^0-9+]/g, "") || "UNKNOWN";
  target = String(target).replace(/[^0-9+]/g, "") || "UNKNOWN";

  // ==========================================================
  // 🧩 Resultado final
  // ==========================================================
  return { mode, source, target, bridgeId, channelId, uniqueId };
}

async function setJson(key, obj, ex = 600) {
  await redis.set(key, JSON.stringify(obj), { EX: ex });
}
async function getJson(key) {
  const v = await redis.get(key);
  return v ? JSON.parse(v) : null;
}

// ------------------------------------------------------
// 🧹 Limpieza y colgado cruzado
// ------------------------------------------------------
async function hangupOriginAndCleanup(ari, linkedId, culpritChannelId) {
  try {
    // 1️⃣ cerrar bridge si existe
    const bridgeId = await redis.get(`bridge:${linkedId}`);
    if (bridgeId) {
      try {
        const b = ari.Bridge();
        b.id = bridgeId;
        const info = await b.get();
        if (Array.isArray(info.channels)) {
          for (const chId of info.channels) {
            if (chId !== culpritChannelId) {
              log("info", `🧹 Colgando canal ${chId} (bridge ${bridgeId})`);
              try { await ari.channels.hangup({ channelId: chId }); } catch {}
            }
          }
        }
        try { await b.destroy(); } catch {}
      } catch {}
    }

    // 2️⃣ si no hay bridge, buscar canales asociados en Redis
    const chMap = (await getJson(`channels:${linkedId}`)) || {};
    const aLeg = chMap.a && chMap.a !== culpritChannelId ? chMap.a : null;
    if (aLeg) {
      try {
        log("info", `🧩 Forzando hangup de A-leg ${aLeg}`);
        await ari.channels.hangup({ channelId: aLeg });
      } catch (e) {
        if (!String(e.message).includes("No such channel")) {
          log("warn", `No se pudo colgar A-leg ${aLeg}: ${e.message}`);
        }
      }
    }

    await redis.del(`activeLinked:${linkedId}`);
    await redis.del(`channels:${linkedId}`);
    await redis.del(`bridge:${linkedId}`);
  } catch (e) {
    log("error", "hangupOriginAndCleanup error", e.message);
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
      const { mode, source: ani, target: dnis } = parseArgs(event, args);
      
      // 🩹 fallback por si Asterisk aún envía "s"
      const safeDnis =
        dnis && dnis !== "s"
          ? dnis
          : (event.channel?.dialplan?.exten ||
             event.channel?.caller?.number ||
             event.channel?.connected?.number ||
             event.channel?.variables?.ORIG_EXT ||
             "UNKNOWN");
      const linkedId = channel.linkedid || channel.id;

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
              // Aquí podrías iniciar un IVR pregrabado o mensaje de cortesía
              await channel.play({ media: "sound:tt-monkeys" });
              await channel.hangup();
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
              await channel.play({ media: "sound:tt-monkeys" });
              await channel.hangup();
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
          const bridge = ari.Bridge();
          await bridge.create({ type: "mixing" });
          await bridge.addChannel({ channel: channel.id });

          // 🧩 Guardar referencia en Redis para seguimiento
          await redis.set(`bridge:${linkedId}`, bridge.id, { EX: 3600 });
          await redis.set(`activeLinked:${linkedId}`, bridge.id, { EX: 3600 });
          await setJson(`channels:${linkedId}`, { a: channel.id }, 3600);

          // 📡 Publicar evento de inicio de llamada (ringing)
          await publish(channel, "call.ringing", {
            channelId: channel.id,
            linkedId,
            ani: safeAni,
            dnis: safeDnis,
            direction: "INTERNAL",
            state: "Ring",
            startedAt: new Date().toISOString(),
          });

          // 🚀 Originar canal destino (B-leg) con ANI y DNIS explícitos
          await ari.channels.originate({
            endpoint: `PJSIP/${safeDnis}`,
            app: APP,
            // 🆕 Enviamos bridgeId, ani, dnis escapando ; para que Asterisk mantenga la cadena completa
            appArgs: `bridge\\;${bridge.id}\\;${safeAni}\\;${safeDnis}`,
            callerId: safeAni,
            timeout: 45,
            context: "from-internal",
            extension: safeDnis,
            priority: 1,
          });

          log("info", `🔗 Canal origen (${safeAni}) conectado, bridge ${bridge.id}`);

          channel.once("StasisEnd", async () => {
            await hangupOriginAndCleanup(ari, linkedId, channel.id);
          });
        } else if (mode === "bridge" && bridgeId) {
          // Parse ANI and DNIS from appArgs: ["bridge", bridgeId, ani, dnis]
          const { source: ani, target: dnis } = parseArgs(event, args);
          const bridge = ari.Bridge();
          bridge.id = bridgeId;
          await channel.answer().catch(() => {});
          await bridge.addChannel({ channel: channel.id });
          log("info", `🔗 Canal ${channel.id} (${ani} → ${dnis}) unido a bridge ${bridge.id}`);
          
          // 🔄 Guardar referencia en Redis
          await redis.set(`bridge:${linkedId}`, bridge.id, { EX: 600 });
          
          // 📡 Publicar estado de llamada para el B-leg
          await publish(channel, "call.state", {
            channelId: channel.id,
            linkedId: channel.linkedid || channel.id,
            ani,
            dnis,
            state: "Up",
            direction: "INTERNAL",
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
          log("info", `🔗 Canal ${channel.id} (${ani} → ${dnis}) conectado`);

          // 🔄 Publicar evento de estado para el canal actual
          await publish(channel, "call.state", {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            state: "Up",
            direction: "INTERNAL",
            startedAt: new Date().toISOString(),
          });

          // 🟢 También actualizar redis
          await redis.set(`activeCall:${channel.id}`, JSON.stringify({
            channelId: channel.id,
            ani,
            dnis,
            state: "Up",
            linkedId,
            direction: "INTERNAL",
          }), { EX: 600 });

          // 🧩 Sincronizar el otro lado del bridge si existe
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
                  direction: "INTERNAL",
                  startedAt: new Date().toISOString(),
                });

                // Actualizar Redis para el canal hermano también
                await redis.set(`activeCall:${ch.id}`, JSON.stringify({
                  channelId: ch.id,
                  ani: otherAni,
                  dnis: otherDnis,
                  state: "Up",
                  linkedId,
                  direction: "INTERNAL",
                }), { EX: 600 });
              }
            }
          } catch (syncErr) {
            log("warn", "Error al sincronizar canales hermanos", syncErr.message);
          }
        }
      } catch (e) {
        log("warn", "Error en ChannelStateChange", e.message);
      }
    });

    // ------------------------------------------------------
    // ☎️ ChannelHangupRequest
    // ------------------------------------------------------
    ari.on("ChannelHangupRequest", async (event, channel) => {
      try {
        const linkedId = channel.linkedid || channel.id;
        const ani = channel?.caller?.number || "";
        const dnis = channel?.dialplan?.exten || "";
        const stateKey = `activeCall:${channel.id}`;
        const callState = await getJson(stateKey);
        const state = callState?.state || channel.state;

        let endReason = "hangup-request";
        if (state === "Ringing" || state === "Ring") {
          endReason = "cancelled-before-answer";
          log("info", `📞 ${ani} → ${dnis} cancelada antes de contestar`);
          await hangupOriginAndCleanup(ari, linkedId, channel.id);
        }

        await publish(channel, "call.hangup", {
          channelId: channel.id,
          linkedId,
          ani,
          dnis,
          reason: endReason,
          endedAt: new Date().toISOString(),
        });
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
              try { await ari.channels.hangup({ channelId: ch.id }); } catch {}
            }
          }
        } catch (err) {
          log("warn", "No se pudo ejecutar hangup directo del A-leg:", err.message);
        }

        // 📡 Publicar call.hangup con información completa
        const callData = await redis.get(`activeCall:${id}`);
        if (callData) {
          const parsed = JSON.parse(callData);
          parsed.state = "Hangup";
          parsed.reason = parsed.reason || "channel-destroyed";
          parsed.endedAt = new Date().toISOString();
          await redis.publish("call.hangup", JSON.stringify(parsed));
          await redis.del(`activeCall:${id}`);
          log("info", `🧹 Limpieza completa canal ${id}`);
        } else {
          // Fallback si no hay datos en Redis
          await publish(channel, "call.hangup", {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            reason: "channel-destroyed",
            endedAt: new Date().toISOString(),
          });
        }

        log("info", `💀 ChannelDestroyed detectado (${ani}) canal ${id}`);
      } catch (e) {
        log("error", "Error en ChannelDestroyed", e.message);
      }
    });

    // ------------------------------------------------------
    // 🧩 DETECTOR DE CORTE DEL ORIGEN (A-leg)
    // ------------------------------------------------------
    ari.on("ChannelLeftBridge", async (event, channel) => {
      try {
        const { id, name, caller, dialplan } = channel;
        const ani = caller?.number || "UNKNOWN";
        const bridgeId = event.bridge?.id;
        const context = dialplan?.context || "unknown";

        log("info", `👋 Canal salió del bridge ${bridgeId || '(sin bridge)'}: ${ani}`);

        // Evitar duplicados si ya se registró hangup
        const key = `activeCall:${id}`;
        const callData = await redis.get(key);
        if (callData) {
          const parsed = JSON.parse(callData);
          if (parsed.state !== 'Hangup') {
            parsed.state = 'Hangup';
            parsed.reason = 'caller-hangup';
            parsed.endedAt = new Date().toISOString();
            await redis.publish('call.hangup', JSON.stringify(parsed));
            await redis.del(key);
            log("info", `📴 Corte detectado del ORIGEN ${ani}, canal ${id}`);
          }
        }
      } catch (err) {
        log("error", "Error manejando ChannelLeftBridge (corte origen)", err);
      }
    });

    // ------------------------------------------------------
    // 🔚 STASIS END
    // ------------------------------------------------------
    ari.on("StasisEnd", async (event, channel) => {
      const linkedId = channel.linkedid || channel.id;
      log("info", `🔚 Fin de llamada LinkedID=${linkedId} / Channel=${channel.id}`);
      await hangupOriginAndCleanup(ari, linkedId, channel.id);
    });

    // ------------------------------------------------------
    // 🚀 Iniciar App ARI
    // ------------------------------------------------------
    ari.start(APP);
  }
);
