import AriClient from "ari-client";
import { sql, poolPromise } from "../lib/db.js";
import redis from "../lib/redis.js";
import { log } from "../lib/logger.js";
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

function parseArgs(event, args) {
  const raw = Array.isArray(args) && args.length ? args : event.args || [];
  let mode, source, target, bridgeId;
  if (raw.length) {
    if (raw[0] === "bridge") {
      mode = "bridge";
      bridgeId = raw[1];
    } else if (raw.length >= 3) {
      [mode, source, target] = raw;
    } else if (typeof raw[0] === "string" && raw[0].includes(",")) {
      [mode, source, target] = raw[0].split(",");
    } else {
      mode = raw[0];
    }
  }
  return { mode, source, target, bridgeId };
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
      const { mode, source, target, bridgeId } = parseArgs(event, args);
      const ani = channel?.caller?.number || source || "";
      const dnis = channel?.dialplan?.exten || target || "";
      const linkedId = channel.linkedid || channel.id;

      try {
        if (mode === "internal") {
          log("info", `📞 INTERNAL | ${ani} → ${dnis}`);
          await channel.answer()
            .then(() => log("info", `✅ Canal origen (${channel.name}) contestado`))
            .catch(err => log("warn", "Error al contestar origen", err.message));

          const bridge = ari.Bridge();
          await bridge.create({ type: "mixing" });
          await bridge.addChannel({ channel: channel.id });

          await redis.set(`bridge:${linkedId}`, bridge.id, { EX: 3600 });
          await setJson(`channels:${linkedId}`, { a: channel.id }, 3600);

          // Origina destino
          await ari.channels.originate({
            endpoint: `PJSIP/${dnis}`,
            app: APP,
            appArgs: `bridge,${bridge.id}`,
            callerId: ani,
            timeout: 45,
            context: "from-internal",
            extension: dnis,
            priority: 1,
          });

          await publish(channel, "call.ringing", {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            direction: "INTERNAL",
            state: "Ring",
            startedAt: new Date().toISOString(),
          });

          channel.once("StasisEnd", async () => {
            await hangupOriginAndCleanup(ari, linkedId, channel.id);
          });
        } else if (mode === "bridge" && bridgeId) {
          const bridge = ari.Bridge();
          bridge.id = bridgeId;
          await channel.answer().catch(() => {});
          await bridge.addChannel({ channel: channel.id });
          log("info", `🔗 Canal ${channel.id} unido a bridge ${bridgeId}`);
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
        const linkedId = channel.linkedid || channel.id;
        const ani = channel?.caller?.number || "";
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

        await publish(channel, "call.hangup", {
          channelId: channel.id,
          linkedId,
          ani,
          dnis,
          reason: "channel-destroyed",
          endedAt: new Date().toISOString(),
        });

        log("info", `🧹 ChannelDestroyed → ${channel.id} (${ani} → ${dnis})`);
      } catch (e) {
        log("error", "Error en ChannelDestroyed", e.message);
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
