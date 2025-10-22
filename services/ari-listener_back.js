import AriClient from "ari-client";
import { sql, poolPromise } from "../lib/db.js";
import redis from "../lib/redis.js";
import { log } from "../lib/logger.js";
import dotenv from "dotenv";
dotenv.config();

// Helpers ---------------------------------------------
const APP = process.env.ARI_APP || "crm-core";

async function publish(channel, type, payload = {}) {
    try {
        await redis.publish(type, JSON.stringify(payload));
    } catch (e) {
        log("warn", `Redis publish error to ${type}`, e.message);
    }
}

function parseArgs(event, args) {
    // Soporta: Stasis(app, internal,src,dst) y Stasis(app, "internal,src,dst")
    const raw = Array.isArray(args) && args.length ? args : (event.args || []);
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

// Limpieza idempotente por LinkedID -------------------
async function cleanupLinked(ari, linkedId, reason = "unknown") {
    const lockKey = `cleanup:${linkedId}`;
    const gotLock = await redis.set(lockKey, "1", { NX: true, EX: 300 });
    if (!gotLock) return; // Ya se limpió

    try {
        const bridgeId = await redis.get(`bridge:${linkedId}`);
        if (bridgeId) {
            try {
                const br = ari.Bridge();
                br.id = bridgeId;
                await br.destroy();
                log("info", `🧹 Bridge ${bridgeId} destruido (cleanup ${reason})`);
            } catch (e) {
                log("warn", `⚠️ Bridge ${bridgeId} ya destruido`, e.message);
            }
        }
    } finally {
        await publish(null, "call.hangup", { linkedId, reason });
        const chs = await getJson(`channels:${linkedId}`);
        if (chs) {
            if (chs.a) await publish(null, "call.hangup", { channelId: chs.a, reason });
            if (chs.b) await publish(null, "call.hangup", { channelId: chs.b, reason });
        }
        await redis.del(`bridge:${linkedId}`, `channels:${linkedId}`, `activeLinked:${linkedId}`);
    }
}


// Conexion ARI ----------------------------------------
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

        // ========== STASIS START ==========
        ari.on("StasisStart", async (event, channel, args) => {
            const { mode, source, target, bridgeId } = parseArgs(event, args);
            const ani = channel?.caller?.number || source || "";
            const dnis = channel?.dialplan?.exten || target || "";
            const linkedId = channel.linkedid || channel.id;

            try {
                if (mode === "internal") {
                    // Origen entra, creamos bridge y originamos destino
                    log("info", `📞 INTERNAL | ${ani} → ${dnis}`);

                    const bridge = ari.Bridge();
                    await bridge.create({ type: "mixing" });
                    await bridge.addChannel({ channel: channel.id });

                    await redis.set(`bridge:${linkedId}`, bridge.id, { EX: 3600 });
                    await setJson(`channels:${linkedId}`, { a: channel.id }, 3600);
                    await redis.set(`activeLinked:${linkedId}`, channel.id, { EX: 3600 });

                    const outgoing = await ari.channels.originate({
                        endpoint: `PJSIP/${dnis}`,
                        app: APP,
                        appArgs: `bridge,${bridge.id}`,
                        callerId: ani,
                        timeout: 45,
                    });

                    const pool = await poolPromise;
                    await pool
                        .request()
                        .input("ChannelId", sql.VarChar(64), channel.id)
                        .input("Direction", sql.VarChar(10), "IN")
                        .input("Ani", sql.VarChar(32), ani)
                        .input("Dnis", sql.VarChar(32), dnis)
                        .input("State", sql.VarChar(20), "RINGING")
                        .input("QueueId", sql.Int, null)
                        .input("AgentId", sql.Int, null)
                        .input("RecordingPath", sql.NVarChar(512), null)
                        .execute("usp_ActiveCalls_Upsert");

                    await publish(channel, "call.ringing", {
                        channelId: channel.id,
                        linkedId,
                        ani,
                        dnis,
                        direction: "INTERNAL",
                        state: "Ring",
                        startedAt: new Date().toISOString(),
                    });

                    // Guarda id del destino cuando llegue a Stasis (ver handler bridge)
                    channel.once("StasisEnd", async () => {
                        await cleanupLinked(ari, linkedId, "caller");
                    });
                } else if (mode === "bridge" && bridgeId) {
                    // El canal destino entra con appArgs=bridge,<bridgeId>
                    const bridge = ari.Bridge();
                    bridge.id = bridgeId;
                    await bridge.addChannel({ channel: channel.id });

                    const linked = channel.linkedid || channel.id;
                    // completar canales
                    const chs = (await getJson(`channels:${linked}`)) || {};
                    if (!chs.b && chs.a !== channel.id) chs.b = channel.id;
                    await setJson(`channels:${linked}`, chs, 3600);

                    const aniB = channel?.caller?.number || ani || "";
                    const dnisB = channel?.dialplan?.exten || dnis || "";

                    const pool = await poolPromise;
                    await pool
                        .request()
                        .input("ChannelId", sql.VarChar(64), channel.id)
                        .input("Direction", sql.VarChar(10), "IN")
                        .input("Ani", sql.VarChar(32), aniB)
                        .input("Dnis", sql.VarChar(32), dnisB)
                        .input("State", sql.VarChar(20), "UP")
                        .input("QueueId", sql.Int, null)
                        .input("AgentId", sql.Int, null)
                        .input("RecordingPath", sql.NVarChar(512), null)
                        .execute("usp_ActiveCalls_Upsert");

                    await publish(channel, "call.state", {
                        channelId: channel.id,
                        linkedId,
                        ani: aniB,
                        dnis: dnisB,
                        direction: "INTERNAL",
                        state: "Up",
                        startedAt: new Date().toISOString(),
                    });

                    log("info", `🔗 Canal ${channel.id} unido a bridge ${bridgeId}`);

                    channel.once("StasisEnd", async () => {
                        await cleanupLinked(ari, linked, "callee");
                    });
                } else {
                    log(
                        "debug",
                        `🟡 Canal en modo desconocido: ${mode} | args=${JSON.stringify(
                            args
                        )}`
                    );
                }
            } catch (e) {
                log("error", "❌ Error en StasisStart", e);
            }
        });

        // ===== Señales fin/estado =====
        // ======= ACTUALIZADO: Detección, sincronización y autocorrección de bridge =======
        ari.on("ChannelStateChange", async (event, channel) => {
            try {
                const linkedId = channel.linkedid || channel.id;
                const ani = channel?.caller?.number || channel?.caller?.name || "";
                let dnis = channel?.dialplan?.exten || "";
                let context = channel?.dialplan?.context || "";

                // Corrige DNIS cuando llega como "s" (contexto sin extensión explícita)
                if (!dnis || dnis === "s") {
                    // Busca en Redis si hay otro canal del mismo linkedId con datos válidos
                    const chs = await getJson(`channels:${linkedId}`);
                    if (chs) {
                        const other = Object.values(chs).find((c) => c && c !== channel.id);
                        if (other) {
                            const cached = await getJson(`activeCall:${other}`);
                            if (cached?.dnis && cached.dnis !== "s") dnis = cached.dnis;
                        }
                    }
                }

                // Ajusta direction para cumplir con el constraint de SQL (IN / OUT)
                let direction = "IN";
                if (context?.toLowerCase().includes("from-internal")) direction = "IN";
                else if (context?.toLowerCase().includes("outbound")) direction = "OUT";

                // 🔄 Publicar siempre el estado actual
                await publish(channel, "call.state", {
                    channelId: channel.id,
                    linkedId,
                    ani,
                    dnis,
                    direction,
                    state: channel.state,
                    updatedAt: new Date().toISOString(),
                });

                // 🔄 Guardar snapshot temporal en Redis
                await setJson(`activeCall:${channel.id}`, {
                    channelId: channel.id,
                    linkedId,
                    ani,
                    dnis,
                    direction,
                    state: channel.state,
                    lastUpdate: new Date().toISOString(),
                });

                // ============================================================
                // ✅ 1. Si el canal pasa a "Up", propagar estado al par del bridge
                // ============================================================
                if (channel.state === "Up") {
                    const chs = await getJson(`channels:${linkedId}`);
                    if (chs) {
                        for (const key of Object.values(chs)) {
                            if (key && key !== channel.id) {
                                await publish(null, "call.state", {
                                    channelId: key,
                                    linkedId,
                                    ani,
                                    dnis,
                                    direction,
                                    state: "Up",
                                    updatedAt: new Date().toISOString(),
                                });
                            }
                        }
                    }

                    // ============================================================
                    // ✅ 2. Autovincular canal al bridge si no estaba asociado
                    // ============================================================
                    const bridgeId = await redis.get(`bridge:${linkedId}`);
                    if (bridgeId) {
                        const bridge = ari.Bridge();
                        bridge.id = bridgeId;
                        try {
                            const members = await bridge.listChannels();
                            const alreadyInBridge = members?.some((c) => c.id === channel.id);
                            if (!alreadyInBridge) {
                                await bridge.addChannel({ channel: channel.id });
                                log("info", `🔗 Canal ${channel.id} agregado dinámicamente a bridge ${bridgeId}`);
                            }
                        } catch (e) {
                            log("warn", `⚠️ No se pudo agregar canal ${channel.id} al bridge ${bridgeId}`, e.message);
                        }
                    }

                    // ============================================================
                    // ✅ 3. Actualizar SQL (por seguridad y visibilidad en CRM)
                    // ============================================================
                    const pool = await poolPromise;
                    await pool
                        .request()
                        .input("ChannelId", sql.VarChar(64), channel.id)
                        .input("Direction", sql.VarChar(10), direction)
                        .input("Ani", sql.VarChar(32), ani)
                        .input("Dnis", sql.VarChar(32), dnis)
                        .input("State", sql.VarChar(20), "UP")
                        .execute("usp_ActiveCalls_Upsert");

                    log("info", `📞 Canal ${channel.id} (${ani} → ${dnis}) ahora está en estado Up`);
                }

                // ============================================================
                // ✅ 4. Si el canal pasa a "Ringing", registrar también en SQL
                // ============================================================
                if (channel.state === "Ringing") {
                    const pool = await poolPromise;
                    await pool
                        .request()
                        .input("ChannelId", sql.VarChar(64), channel.id)
                        .input("Direction", sql.VarChar(10), direction)
                        .input("Ani", sql.VarChar(32), ani)
                        .input("Dnis", sql.VarChar(32), dnis)
                        .input("State", sql.VarChar(20), "RINGING")
                        .execute("usp_ActiveCalls_Upsert");

                    log("info", `🔔 Canal ${channel.id} (${ani} → ${dnis}) en estado Ringing`);
                }
            } catch (e) {
                log("warn", "ChannelStateChange handler error", e.message);
            }
        });

        ari.on("ChannelAnswered", async (event, channel) => {
            try {
                const linkedId = channel.linkedid || channel.id;
                const ani = channel?.caller?.number || "";
                const dnis = channel?.dialplan?.exten || "";
                const direction = channel?.dialplan?.context === "from-internal" ? "INTERNAL" : "OUTBOUND";

                await publish(channel, "call.state", {
                    channelId: channel.id,
                    linkedId,
                    ani,
                    dnis,
                    direction,
                    state: "Up",
                    updatedAt: new Date().toISOString(),
                });

                // actualizar registro SQL (por seguridad)
                const pool = await poolPromise;
                await pool
                    .request()
                    .input("ChannelId", sql.VarChar(64), channel.id)
                    .input("Direction", sql.VarChar(10), direction)
                    .input("Ani", sql.VarChar(32), ani)
                    .input("Dnis", sql.VarChar(32), dnis)
                    .input("State", sql.VarChar(20), "UP")
                    .execute("usp_ActiveCalls_Upsert");
            } catch (e) {
                log("error", "Error en ChannelAnswered", e.message);
            }
        });

        ari.on("ChannelHangupRequest", async (event, channel) => {
            const linkedId = channel.linkedid || channel.id;
            const ani = channel?.caller?.number || "";
            const dnis = channel?.dialplan?.exten || "";
            const direction = channel?.dialplan?.context === "from-internal" ? "INTERNAL" : "OUTBOUND";

            await publish(channel, "call.hangup", {
                channelId: channel.id,
                linkedId,
                ani,
                dnis,
                direction,
                reason: "hangup-request",
                endedAt: new Date().toISOString(),
            });

            await cleanupLinked(ari, linkedId, "hangup-request");
        });

        ari.on("ChannelAnswered", async (event, channel) => {
            try {
                const linkedId = channel.linkedid || channel.id;
                const ani = channel?.caller?.number || "";
                const dnis = channel?.dialplan?.exten || "";
                const direction = channel?.dialplan?.context === "from-internal" ? "INTERNAL" : "OUTBOUND";

                await publish(channel, "call.state", {
                    channelId: channel.id,
                    linkedId,
                    ani,
                    dnis,
                    direction,
                    state: "Up",
                    updatedAt: new Date().toISOString(),
                });

                // actualizar registro SQL (por seguridad)
                const pool = await poolPromise;
                await pool
                    .request()
                    .input("ChannelId", sql.VarChar(64), channel.id)
                    .input("Direction", sql.VarChar(10), direction)
                    .input("Ani", sql.VarChar(32), ani)
                    .input("Dnis", sql.VarChar(32), dnis)
                    .input("State", sql.VarChar(20), "UP")
                    .execute("usp_ActiveCalls_Upsert");
            } catch (e) {
                log("error", "Error en ChannelAnswered", e.message);
            }
        });

        ari.on("ChannelHangupRequest", async (event, channel) => {
            const linkedId = channel.linkedid || channel.id;
            const ani = channel?.caller?.number || "";
            const dnis = channel?.dialplan?.exten || "";
            const direction = channel?.dialplan?.context === "from-internal" ? "INTERNAL" : "OUTBOUND";

            await publish(channel, "call.hangup", {
                channelId: channel.id,
                linkedId,
                ani,
                dnis,
                direction,
                reason: "hangup-request",
                endedAt: new Date().toISOString(),
            });

            await cleanupLinked(ari, linkedId, "hangup-request");
        });

        ari.on("ChannelDestroyed", async (event, channel) => {
            try {
                const linkedId = channel.linkedid || channel.id;
                const ani = channel?.caller?.number || "";
                const dnis = channel?.dialplan?.exten || "";
                const direction =
                    channel?.dialplan?.context === "from-internal"
                        ? "INTERNAL"
                        : "OUTBOUND";

                // Notificamos al watcher
                await publish(channel, "call.hangup", {
                    channelId: channel.id,
                    linkedId,
                    ani,
                    dnis,
                    direction,
                    reason: "channel-destroyed",
                    endedAt: new Date().toISOString(),
                });

                // Cleanup idempotente
                await cleanupLinked(ari, linkedId, "channel-destroyed");

                log(
                    "info",
                    `🧹 ChannelDestroyed → ${channel.id} (linkedId=${linkedId}, ani=${ani}, dnis=${dnis})`
                );
            } catch (e) {
                log("error", "Error en ChannelDestroyed", e.message);
            }
        });

        // Hold / Unhold (si el endpoint usa reinvite a=sendonly/inactive)
        ari.on("ChannelHold", async (event, channel) => {
            try {
                const linkedId = channel.linkedid || channel.id;
                const ani = channel?.caller?.number || "";
                const dnis = channel?.dialplan?.exten || "";
                const direction =
                    channel?.dialplan?.context === "from-internal"
                        ? "INTERNAL"
                        : "OUTBOUND";

                await publish(channel, "call.hold", {
                    channelId: channel.id,
                    linkedId,
                    ani,
                    dnis,
                    direction,
                    onHold: true,
                    updatedAt: new Date().toISOString(),
                });

                // Reflejar en SQL (opcional)
                const pool = await poolPromise;
                await pool
                    .request()
                    .input("ChannelId", sql.VarChar(64), channel.id)
                    .input("Direction", sql.VarChar(10), direction)
                    .input("Ani", sql.VarChar(32), ani)
                    .input("Dnis", sql.VarChar(32), dnis)
                    .input("State", sql.VarChar(20), "HOLD")
                    .execute("usp_ActiveCalls_Upsert");

                log(
                    "info",
                    `⏸️ ChannelHold → ${channel.id} (${ani} → ${dnis}) linked=${linkedId}`
                );
            } catch (e) {
                log("warn", "Error en ChannelHold", e.message);
            }
        });

        ari.on("ChannelUnhold", async (event, channel) => {
            try {
                const linkedId = channel.linkedid || channel.id;
                const ani = channel?.caller?.number || "";
                const dnis = channel?.dialplan?.exten || "";
                const direction =
                    channel?.dialplan?.context === "from-internal"
                        ? "INTERNAL"
                        : "OUTBOUND";

                await publish(channel, "call.hold", {
                    channelId: channel.id,
                    linkedId,
                    ani,
                    dnis,
                    direction,
                    onHold: false,
                    updatedAt: new Date().toISOString(),
                });

                // Actualiza estado SQL a "UP"
                const pool = await poolPromise;
                await pool
                    .request()
                    .input("ChannelId", sql.VarChar(64), channel.id)
                    .input("Direction", sql.VarChar(10), direction)
                    .input("Ani", sql.VarChar(32), ani)
                    .input("Dnis", sql.VarChar(32), dnis)
                    .input("State", sql.VarChar(20), "UP")
                    .execute("usp_ActiveCalls_Upsert");

                log(
                    "info",
                    `▶️ ChannelUnhold → ${channel.id} (${ani} → ${dnis}) linked=${linkedId}`
                );
            } catch (e) {
                log("warn", "Error en ChannelUnhold", e.message);
            }
        });

        // ===== Cierre en StasisEnd genérico (persistencia / CDR app) =====
        ari.on("StasisEnd", async (event, channel) => {
            const linkedId = channel.linkedid || channel.id;
            log("info", `🔚 Fin de llamada LinkedID=${linkedId} / Channel=${channel.id}`);
            try {
                const activeKey = (await redis.get(`activeLinked:${linkedId}`)) || channel.id;
                const pool = await poolPromise;
                await pool
                    .request()
                    .input("ChannelId", sql.VarChar(64), activeKey)
                    .input("Status", sql.VarChar(32), "ENDED")
                    .execute("usp_CallLogs_InsertFromActive");
                await publish(channel, "call.hangup", { channelId: activeKey });
            } catch (e) {
                log("error", "Error al cerrar llamada", e);
            }
        });

        ari.start(APP);
    }
);
