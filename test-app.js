// test-app.js — Compatible con Asterisk 20+
import AriClient from "ari-client";

const run = async () => {
  try {
    const ari = await AriClient.connect("http://127.0.0.1:8088/ari", "crm_ari", "1234");
    console.log("✅ Conectado a ARI correctamente (modo directo)");

    // Listar endpoints disponibles
    try {
      const endpoints = await ari.endpoints.list();
      console.log("📡 Endpoints detectados:");
      endpoints.forEach(e =>
        console.log(`   ${e.resource} (${e.state})`)
      );
    } catch (err) {
      console.error("❌ Error obteniendo endpoints:", err.message);
    }

    // Llamadas entrantes (cuando StasisStart se dispare)
    ari.on("StasisStart", async (event, channel) => {
      console.log(`📞 Llamada entrante en ${channel.name}`);
      try {
        await channel.answer();
        console.log("📞 Llamada contestada, colgando en 3s...");
        setTimeout(() => ari.channels.hangup({ channelId: channel.id }), 3000);
      } catch (err) {
        console.error("❌ Error manejando la llamada:", err.message);
      }
    });

    // Inicia el cliente (registra la app testapp)
    ari.start("testapp");
  } catch (err) {
    console.error("❌ Error conectando a ARI:", err.message);
  }
};

run();
