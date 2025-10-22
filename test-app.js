// test-app.js — Compatible con Asterisk 20+
import Ari from "asterisk-ari";

const ari = new Ari({
  url: "http://127.0.0.1:8088",  // no necesita /ari/api-docs
  username: "crm_ari",
  password: "1234"
});

ari.on("ready", async () => {
  console.log("✅ Conectado a ARI correctamente (modo directo)");

  // Listar endpoints disponibles
  try {
    const endpoints = await ari.get("/ari/endpoints");
    console.log("📡 Endpoints detectados:");
    endpoints.forEach(e =>
      console.log(`   ${e.resource} (${e.state})`)
    );
  } catch (err) {
    console.error("❌ Error obteniendo endpoints:", err.message);
  }
});

// Llamadas entrantes (cuando StasisStart se dispare)
ari.on("StasisStart", async (event, channel) => {
  console.log(`📞 Llamada entrante en ${channel.name}`);
  try {
    await ari.post(`/ari/channels/${channel.id}/answer`);
    console.log("📞 Llamada contestada, colgando en 3s...");
    setTimeout(() => ari.delete(`/ari/channels/${channel.id}`), 3000);
  } catch (err) {
    console.error("❌ Error manejando la llamada:", err.message);
  }
});

// Inicia el cliente (registra la app testapp)
ari.start("testapp");
