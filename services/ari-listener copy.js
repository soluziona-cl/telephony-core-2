
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
// 👤 Funciones para gestión de estado de agentes
// ------------------------------------------------------
async function updateAgentStatus(agentId, status, channelId = null, linkedId = null) {
  try {
    const payload = {
      agentId,
      status,
      channelId,
      linkedId,
      timestamp: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Guardar en Redis
    await setJson(`agent:${agentId}`, payload, 3600);
    
    // Publicar evento
    await redis.publish('agent.status', JSON.stringify(payload));
    
    log("info", `👤 Estado de agente ${agentId} actualizado a: ${status}`);
  } catch (error) {
    log("error", `Error actualizando estado del agente ${agentId}`, error.message);
  }
}

async function getAgentByChannel(channelId) {
  try {
    // Buscar agente por canal en diferentes ubicaciones
    const keys = await redis.keys(`agent:*:channel:${channelId}`);
    if (keys.length > 0) {
      const agentData = await getJson(keys[0]);
      return agentData;
    }
    
    // Buscar en activeCall
    const callData = await getJson(`activeCall:${channelId}`);
    if (callData && callData.agentId) {
      return { agentId: callData.agentId };
    }
    
    return null;
  } catch (error) {
    log("warn", `Error buscando agente por canal ${channelId}`, error.message);
    return null;
  }
}

async function detectAgentFromChannel(channel) {
  try {
    // Método 1: Extraer del nombre del canal (PJSIP/1001-00000001 → 1001)
    const channelName = channel.name || '';
    const agentMatch = channelName.match(/PJSIP\/(\d+)-/);
    if (agentMatch) {
      log("debug", `🔍 Agente detectado por nombre de canal: ${agentMatch[1]}`);
      return agentMatch[1];
    }
    
    // Método 2: Buscar en variables del canal
    const variables = channel.variables || {};
    if (variables.AGENT_ID) {
      log("debug", `🔍 Agente detectado por variable AGENT_ID: ${variables.AGENT_ID}`);
      return variables.AGENT_ID;
    }
    
    // Método 3: Para llamadas OUTBOUND, el ANI es el agente
    const direction = detectDirection(channel);
    if (direction === "OUTBOUND") {
      const ani = channel?.caller?.number;
      if (ani && ani.length <= 4) {
        log("debug", `🔍 Agente detectado por ANI outbound: ${ani}`);
        return ani;
      }
    }
    
    // Método 4: Para llamadas INBOUND, el DNIS podría ser la extensión del agente
    if (direction === "INBOUND") {
      const dnis = channel.dialplan?.exten;
      if (dnis && dnis.length <= 4) { // Asumiendo extensiones cortas
        log("debug", `🔍 Agente detectado por DNIS inbound: ${dnis}`);
        return dnis;
      }
    }
    
    // Método 5: DNIS genérico (fallback)
    const dnis = channel.dialplan?.exten;
    if (dnis && dnis.length <= 4) {
      log("debug", `🔍 Agente detectado por DNIS genérico: ${dnis}`);
      return dnis;
    }
    
    log("debug", `🔍 No se pudo detectar agente para canal ${channel.id} (direction: ${direction})`);
    return null;
  } catch (error) {
    log("warn", "Error detectando agente desde canal", error.message);
    return null;
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
// 🧹 Limpieza y colgado cruzado MEJORADA
// ------------------------------------------------------
async function hangupOriginAndCleanup(ari, linkedId, culpritChannelId) {
  if (!linkedId) {
    log("warn", "🧹 linkedId undefined - saltando limpieza");
    return;
  }

  const lockKey = `cleanup:${linkedId}`;
  let lockValue = null;
  
  try {
    lockValue = await acquireLock(lockKey, 30); // Aumentar TTL a 30 segundos
    if (!lockValue) {
      log("debug", `🧹 Limpieza ya en progreso para ${linkedId} - saltando`);
      return;
    }

    log("info", `🧹 Iniciando limpieza para linkedId=${linkedId}, culprit=${culpritChannelId}`);

    // 🔄 1. Obtener bridgeId primero
    const bridgeId = await redis.get(`bridge:${linkedId}`);
    
    // 🔄 2. Limpiar referencias de agentes
    try {
      const chans = await ari.channels.list();
      const relatedChannels = chans.filter(ch => 
        ch.linkedid === linkedId || ch.id === culpritChannelId
      );

      for (const ch of relatedChannels) {
        await redis.del(`agent:channel:${ch.id}`);
        log("debug", `🧹 Referencia Redis limpiada para canal ${ch.id}`);
      }
    } catch (agentErr) {
      log("warn", "Error limpiando referencias Redis", agentErr.message);
    }

    // 🔄 3. Destruir bridge si existe
    if (bridgeId) {
      try {
        const bridge = ari.Bridge();
        bridge.id = bridgeId;
        await bridge.destroy();
        log("info", `💥 Bridge ${bridgeId} destruido`);
      } catch (err) {
        if (!err.message.includes("not found")) {
          log("warn", `Error destruyendo bridge ${bridgeId}:`, err.message);
        }
      }
    }

    // 🔄 4. Limpiar Redis
    const keysToDelete = [
      `activeLinked:${linkedId}`,
      `channels:${linkedId}`,
      `bridge:${linkedId}`,
      `linkedId:${bridgeId}`,
      `recording:${linkedId}`,
      `recordingPath:${linkedId}`
    ];

    for (const key of keysToDelete) {
      try {
        await redis.del(key);
      } catch (e) {
        // Ignorar errores de eliminación
      }
    }

    // 🔄 5. Limpiar activeCall relacionados
    try {
      const activeCallKeys = await redis.keys(`activeCall:*`);
      for (const key of activeCallKeys) {
        const data = await getJson(key);
        if (data && data.linkedId === linkedId) {
          await redis.del(key);
        }
      }
    } catch (e) {
      log("warn", "Error limpiando activeCall keys", e.message);
    }

    log("info", `🧹 Limpieza completada para ${linkedId}`);

  } catch (e) {
    log("error", "hangupOriginAndCleanup error", e.message);
  } finally {
    if (lockValue) {
      try {
        await releaseLock(lockKey, lockValue);
      } catch (relErr) {
        log("error", `Error liberando lock ${lockKey}`, relErr.message);
        try { await redis.del(lockKey); } catch {}
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

          // 🧩 Guardar referencia en Redis para seguimiento
          await redis.set(`bridge:${linkedId}`, bridgeId, { EX: 3600 });
          await redis.set(`activeLinked:${linkedId}`, bridgeId, { EX: 3600 });
          await setJson(`channels:${linkedId}`, { a: channel.id }, 3600);
          
          // 🆕 FORZAR linkedId consistente para el B-leg
          await redis.set(`linkedId:${bridgeId}`, linkedId, { EX: 3600 });

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
                  const chAgentId = await detectAgentFromChannel(ch);
                  await publishHangupOnce(ch, {
                    channelId: ch.id,
                    linkedId,
                    ani: ch?.caller?.number || "",
                    dnis: ch?.dialplan?.exten || "",
                    reason: "timeout",
                    agentId: chAgentId || null,
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
        } else if (mode === "bridge") {
          // **** ARREGLO CRÍTICO: usar bridgeId del parseo ****
          const bridge = await ensureBridge(ari, bridgeId);
          await channel.answer().catch(() => { });
          await bridge.addChannel({ channel: channel.id });
          
          // 🆕 OBTENER linkedId del bridge en lugar del canal
          const bridgeLinkedId = await redis.get(`linkedId:${bridgeId}`) || channel.linkedid || channel.id;
          
          log("info", `🔗 Canal ${channel.id} (${ani} → ${dnis}) unido a bridge ${bridgeId} [linkedId: ${bridgeLinkedId}]`);

          // 🆕 USAR linkedId consistente
          await redis.set(`bridge:${bridgeLinkedId}`, bridgeId, { EX: 600 });

          // 📡 Publicar estado de llamada para el B-leg
          await publish(channel, "call.state", {
            channelId: channel.id,
            linkedId: bridgeLinkedId, // 🆕 Usar linkedId consistente
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
        const bridgeId = await redis.get(`bridge:${linkedId}`);
        
        log("debug", `🔍 ChannelStateChange: ${channel.id}, linkedId: ${linkedId}, bridge: ${bridgeId}, state: ${channel.state}`);
        
        const ani = channel?.caller?.number || "";
        const dnis = channel?.dialplan?.exten || "";
        const state = channel.state;

        // 🆕 DETECTAR AGENTE
        const agentId = await detectAgentFromChannel(channel);
        
        const callData = {
          channelId: channel.id,
          linkedId,
          ani,
          dnis,
          state,
          agentId: agentId || null,
          lastUpdate: new Date().toISOString(),
        };

        await setJson(`activeCall:${channel.id}`, callData);

        if (state === "Ringing") {
          log("info", `🔔 Canal ${channel.id} (${ani} → ${dnis}) en Ringing`);
          
          // 🆕 ACTUALIZAR AGENTE A "RINGING"
          if (agentId) {
            await updateAgentStatus(agentId, "ringing", channel.id, linkedId);
          }
        } else if (state === "Up") {
          const direction = detectDirection(channel);

          log("info", `🔗 Canal ${channel.id} (${ani} → ${dnis}) conectado [${direction}]`);

          // --- 🔒 FIX: normalizar "s" en destino ---
          if (!dnis || dnis.toLowerCase() === "s" || dnis.toLowerCase() === "null") {
            dnis = channel?.connected?.number || channel?.caller?.number || "";
          }
          if (!ani || ani.toLowerCase() === "s" || ani.toLowerCase() === "null") {
            ani = channel?.caller?.number || channel?.connected?.number || "";
          }
          ani = ani.replace(/[^0-9+]/g, "");
          dnis = dnis.replace(/[^0-9+]/g, "");
          // --- FIN FIX ---

          // 📡 --- Publicar evento de estado ---
          await publish(channel, "call.state", {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            state: "Up",
            direction,
            agentId: agentId || null,
            startedAt: new Date().toISOString(),
          });

          // 🟢 --- Actualizar Redis ---
          callData.direction = direction;
          await setJson(`activeCall:${channel.id}`, callData);

          // 🆕 ACTUALIZAR AGENTE A "IN-CALL"
          if (agentId) {
            await updateAgentStatus(agentId, "in-call", channel.id, linkedId);
            
            // Guardar referencia adicional para búsqueda rápida
            await redis.set(`agent:channel:${channel.id}`, agentId, { EX: 3600 });
          }

          // 🧩 --- Sincronizar canal hermano ---
          try {
            const chans = await ari.channels.list();
            for (const ch of chans) {
              if (ch.linkedid === linkedId && ch.id !== channel.id) {
                const otherAni = ch.caller?.number || "";
                const otherDnis = ch.dialplan?.exten || "";
                const otherAgentId = await detectAgentFromChannel(ch);

                log("info", `🔄 Sincronizando canal hermano ${ch.id} (${otherAni} → ${otherDnis})`);

                await publish(ch, "call.state", {
                  channelId: ch.id,
                  linkedId,
                  ani: otherAni,
                  dnis: otherDnis,
                  state: "Up",
                  direction,
                  agentId: otherAgentId || null,
                  startedAt: new Date().toISOString(),
                });

                const otherCallData = {
                  channelId: ch.id,
                  ani: otherAni,
                  dnis: otherDnis,
                  state: "Up",
                  linkedId,
                  direction,
                  agentId: otherAgentId || null,
                };
                await setJson(`activeCall:${ch.id}`, otherCallData);

                // 🆕 ACTUALIZAR AGENTE HERMANO SI EXISTE
                if (otherAgentId) {
                  await updateAgentStatus(otherAgentId, "in-call", ch.id, linkedId);
                  await redis.set(`agent:channel:${ch.id}`, otherAgentId, { EX: 3600 });
                }
              }
            }
          } catch (syncErr) {
            log("warn", "Error al sincronizar canales hermanos", syncErr.message);
          }

          // 🟣 --- 2️⃣ Iniciar grabación automática con fallback ---
          try {
            const recName = `${linkedId}_${ani}_${dnis}`.replace(/[^0-9A-Za-z_+]/g, "_");
            
            // Usar recordStored que es más confiable
            await ari.recordings.recordStored({
              name: recName,
              format: "wav",
              maxDurationSeconds: 3600, // 1 hora máximo
              maxSilenceSeconds: 10,
              ifExists: "overwrite",
              beep: false
            });
            
            await redis.set(`recording:${linkedId}`, recName, { EX: 3600 });
            log("info", `🎙️ Grabación iniciada (${recName}.wav)`);
          } catch (err) {
            log("warn", "No se pudo iniciar grabación", err.message);
            // Continuar sin grabación
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

          // 🆕 SOLO LIMPIAR REFERENCIA REDIS EN CASO DE FALLO
          if (agentId) {
            await redis.del(`agent:channel:${channel.id}`);
            log("debug", `🧹 Referencia Redis limpiada para agente ${agentId} (fallo)`);
          }

          await publishHangupOnce(channel, {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            reason,
            agentId: agentId || null,
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
    // ☎️ ChannelHangupRequest — detectar corte en Ringing y colgar destino al tiro
    // ------------------------------------------------------
    ari.on("ChannelHangupRequest", async (event, channel) => {
      try {
        const linkedId = channel.linkedid || channel.id;
        const ani = channel?.caller?.number || "";
        const dnis = channel?.dialplan?.exten || "";
        const stateKey = `activeCall:${channel.id}`;
        const snapshot = await getJson(stateKey);
        const st = snapshot?.state || channel.state;

        // 🆕 SOLO LIMPIAR REFERENCIA REDIS, NO ACTUALIZAR ESTADO
        const agentId = await detectAgentFromChannel(channel);
        log("debug", `📞 Hangup Request - Channel: ${channel.id}, Agent: ${agentId || 'N/A'}, State: ${st}`);
        if (agentId) {
          await redis.del(`agent:channel:${channel.id}`);
          log("debug", `🧹 Referencia Redis limpiada para agente ${agentId} (hangup request)`);
        }

        // Caso especial: corte en RINGING => cancelar B-leg inmediato
        if (st === "Ringing" || st === "Ring") {
          log("info", `📞 ${ani} → ${dnis} cancelada ANTES de contestar (origen colgó)`);

          // Publica hangup origen
          await publishHangupOnce(channel, {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            reason: "cancelled-before-answer",
            agentId: agentId || null,
            direction: detectDirection(channel),
            endedAt: new Date().toISOString(),
          });

          // Fuerza hangup del destino si existe
          try {
            const chans = await ari.channels.list();
            for (const ch of chans) {
              if (ch.linkedid === linkedId && ch.id !== channel.id) {
                const otherAgentId = await detectAgentFromChannel(ch);
                log("info", `🧩 Forzando hangup del destino (${ch.id}) en Ringing`);
                try { await ari.channels.hangup({ channelId: ch.id }); } catch { }
                
                // 🆕 SOLO LIMPIAR REFERENCIA REDIS DEL AGENTE DESTINO
                if (otherAgentId) {
                  await redis.del(`agent:channel:${ch.id}`);
                  log("debug", `🧹 Referencia Redis limpiada para agente destino ${otherAgentId}`);
                }
                
                await publishHangupOnce(ch, {
                  channelId: ch.id,
                  linkedId,
                  ani: ch?.caller?.number || ani || "",
                  dnis: ch?.dialplan?.exten || dnis || "",
                  reason: "cancelled-by-origin",
                  agentId: otherAgentId || null,
                  direction: detectDirection(ch),
                  endedAt: new Date().toISOString(),
                });
              }
            }
          } catch (e) {
            log("warn", "No se pudo forzar hangup destino durante Ringing", e.message);
          }

          await hangupOriginAndCleanup(ari, linkedId, channel.id);
          return;
        }

        // Caso general: post-answered o cortes varios
        await publishHangupOnce(channel, {
          channelId: channel.id,
          linkedId,
          ani,
          dnis,
          reason: "hangup-request",
          agentId: agentId || null,
          direction: detectDirection(channel),
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

        // 🆕 SOLO LIMPIAR REFERENCIA REDIS, NO ACTUALIZAR ESTADO
        const agentId = await detectAgentFromChannel(channel);
        log("debug", `📞 Channel Destroyed - Channel: ${channel.id}, Agent: ${agentId || 'N/A'}, State: ${lastState}`);
        if (agentId) {
          await redis.del(`agent:channel:${channel.id}`);
          log("debug", `🧹 Referencia Redis limpiada para agente ${agentId} (channel destroyed)`);
        }

        if (lastState === "Ringing" || lastState === "Ring") {
          log("info", `📞 ${ani} → ${dnis} cancelada antes de contestar`);
          await publish(channel, "call.cancelled", {
            channelId: channel.id,
            linkedId,
            ani,
            dnis,
            agentId: agentId || null,
            cancelledAt: new Date().toISOString(),
          });
        }

        await hangupOriginAndCleanup(ari, linkedId, channel.id);

        // 🔹 Forzar corte manual si A-leg huérfano sigue activo
        try {
          const chans = await ari.channels.list();
          for (const ch of chans) {
            if (ch.caller?.number === ani && ch.id !== channel.id) {
              const otherAgentId = await detectAgentFromChannel(ch);
              log("info", `🧩 Forzando hangup del A-leg huérfano (${ch.id}) de ${ani}`);
              try { await ari.channels.hangup({ channelId: ch.id }); } catch { }
              
              // 🆕 SOLO LIMPIAR REFERENCIA REDIS DEL AGENTE HUÉRFANO
              if (otherAgentId) {
                await redis.del(`agent:channel:${ch.id}`);
                log("debug", `🧹 Referencia Redis limpiada para agente huérfano ${otherAgentId}`);
              }
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
              const recording = ari.recordings();
              recording.name = recName;
              await recording.stop();
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
              agentId: agentId || null,
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
              agentId: agentId || null,
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
    // 🧩 DETECTOR DE CORTE DEL ORIGEN (A-leg)
    // ------------------------------------------------------
    ari.on("ChannelLeftBridge", async (event, object) => {
      try {
        // Verificar si el objeto es un canal
        const channel = object.id ? object : null;
        if (!channel) {
          log("warn", "ChannelLeftBridge: objeto de canal no válido");
          return;
        }

        const { id, caller } = channel;
        const ani = caller?.number || "UNKNOWN";
        const bridgeId = event.bridge?.id;
        const linkedId = channel.linkedid || channel.id;

        log("info", `👋 Canal ${id} (${ani}) salió del bridge ${bridgeId}`);

        // 🆕 SOLO LIMPIAR REFERENCIA REDIS, NO ACTUALIZAR ESTADO
        const agentId = await detectAgentFromChannel(channel);
        log("debug", `📞 Channel Left Bridge - Channel: ${channel.id}, Agent: ${agentId || 'N/A'}, Bridge: ${bridgeId}`);
        if (agentId) {
          await redis.del(`agent:channel:${channel.id}`);
          log("debug", `🧹 Referencia Redis limpiada para agente ${agentId} (left bridge)`);
        }

        // 🧹 Publicar fin del origen inmediatamente
        const key = `activeCall:${id}`;
        const callData = await redis.get(key);
        if (callData) {
          const parsed = JSON.parse(callData);
          parsed.state = 'Hangup';
          parsed.reason = 'caller-hangup';
          parsed.agentId = agentId || null;
          parsed.endedAt = new Date().toISOString();
          await redis.publish('call.hangup', JSON.stringify(parsed));
          await redis.del(key);
        }

        // 🧩 Forzar limpieza completa y corte del otro extremo
        await hangupOriginAndCleanup(ari, linkedId, id);

        // 🩹 Adicional: destruir el bridge si quedó colgado
        if (bridgeId) {
          try {
            const b = ari.Bridge();
            b.id = bridgeId;
            await b.destroy();
            log("info", `💥 Bridge ${bridgeId} destruido tras salida del origen`);
          } catch (err) {
            log("warn", `No se pudo destruir bridge ${bridgeId}: ${err.message}`);
          }
        }
      } catch (err) {
        log("error", "Error manejando ChannelLeftBridge (corte origen)", err);
      }
    });

    // ==========================================
    // 🧩 BLOQUE FINAL — Corrección cortes cruzados MEJORADA
    // ==========================================
    async function forceHangupPair(ari, linkedId, culpritId, reason = "cancelled-by-origin") {
      const lockKey = `forceHangup:${linkedId}`;
      const lockValue = await acquireLock(lockKey, 10);
      
      if (!lockValue) {
        log("debug", `🧩 ForceHangupPair ya en progreso para ${linkedId} - saltando`);
        return;
      }

      try {
        // 🆕 BUSCAR CANALES POR BRIDGE EN LUGAR DE LINKEDID
        const bridgeId = await redis.get(`bridge:${linkedId}`);
        let relatedChannels = [];

        if (bridgeId) {
          try {
            const bridge = ari.Bridge();
            bridge.id = bridgeId;
            const info = await bridge.get();
            if (Array.isArray(info.channels)) {
              relatedChannels = info.channels.filter(chId => chId !== culpritId);
            }
          } catch (err) {
            log("warn", `No se pudo obtener bridge ${bridgeId} para forceHangup`, err.message);
          }
        }

        // 🆕 FALLBACK: buscar por linkedId si no hay bridge
        if (relatedChannels.length === 0) {
          const chans = await ari.channels.list();
          relatedChannels = chans
            .filter(c => c.linkedid === linkedId && c.id !== culpritId)
            .map(c => c.id);
        }

        for (const chId of relatedChannels) {
          log("info", `🧩 Forzando hangup cruzado del canal ${chId} (${reason})`);
          
          try {
            await ari.channels.hangup({ channelId: chId });
          } catch (err) {
            if (!err.message.includes("No such channel")) {
              log("warn", `Error colgando canal ${chId}:`, err.message);
            }
          }

          // Intentar detectar agente del canal antes de publicar
          const chAgentId = await detectAgentFromChannel({ id: chId });
          await publishHangupOnce({ id: chId }, {
            channelId: chId,
            linkedId,
            ani: "", // No tenemos info del canal
            dnis: "",
            direction: "UNKNOWN", 
            reason,
            agentId: chAgentId || null,
            endedAt: new Date().toISOString(),
          });

          await redis.setEx(`hangup:${chId}`, 15, "1");
        }

      } catch (err) {
        log("warn", `Error en forceHangupPair(${linkedId})`, err.message);
      } finally {
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
  }
);

