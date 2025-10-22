import AriClient from "ari-client";

const run = async () => {
  try {
    const ari = await AriClient.connect("http://127.0.0.1:8088", "crm_ari", "1234");

    console.log("✅ Conectado a ARI correctamente");

    const endpoints = await ari.endpoints.list();
    console.log("📡 Endpoints detectados:");
    endpoints.forEach(e => console.log(`   ${e.resource} — ${e.state}`));

    const bridges = await ari.bridges.list();
    console.log("🔗 Bridges activos:", bridges.length);

    await ari.disconnect(); // cerrar conexión limpia
  } catch (err) {
    console.error("❌ Error conectando a ARI:", err.message);
  }
};

run();
