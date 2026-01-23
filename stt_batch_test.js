#!/usr/bin/env node

/**
 * STT BATCH TEST – QA FORENSE
 * Uso:
 *   node stt_batch_test.js /ruta/al/audio.wav
 */
import { File } from "node:buffer";
if (!globalThis.File) {
  globalThis.File = File;
}

import fs from "fs";
import "dotenv/config";
import OpenAI from "openai";
import path from "path";

const audioPath = process.argv[2] || "/var/lib/asterisk/sounds/voicebot_test/test_02_rut_valido.wav";

if (!audioPath) {
  console.error("❌ Debes indicar un archivo WAV");
  process.exit(1);
}

if (!fs.existsSync(audioPath)) {
  console.error(`❌ Archivo no existe: ${audioPath}`);
  process.exit(1);
}

const stat = fs.statSync(audioPath);
if (stat.size < 8000) {
  console.error("❌ Archivo demasiado pequeño (posible silencio)");
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY no definida en el entorno");
  process.exit(1);
}

console.log("🎧 STT BATCH TEST");
console.log("📄 Archivo :", audioPath);
console.log("📦 Tamaño :", stat.size, "bytes");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function run() {
  const start = Date.now();

  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "gpt-4o-transcribe",
    language: "es"
  });

  const latency = Date.now() - start;
  const text = (transcription.text || "").trim();

  console.log("\n🧠 RESULTADO STT");
  console.log("────────────────────────────");
  console.log("Texto      :", text || "(VACÍO)");
  console.log("Longitud   :", text.length);
  console.log("Latencia   :", latency, "ms");

  if (!text) {
    console.error("\n❌ FALLA: STT no devolvió texto");
    process.exit(2);
  }

  console.log("\n✅ OK: STT batch funcionando correctamente");
}

run().catch(err => {
  console.error("\n❌ ERROR STT:");
  console.error(err.message);
  process.exit(3);
});
