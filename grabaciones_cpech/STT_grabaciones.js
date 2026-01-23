#!/usr/bin/env node

/**
 * STT BATCH PROCESSOR - CPECH
 * Procesamiento masivo de grabaciones para ADMISION y ATENCION_GENERAL
 */
import { File } from "node:buffer";
if (!globalThis.File) {
  globalThis.File = File;
}

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Cargar .env desde la raíz del proyecto
dotenv.config({ path: "/opt/telephony-core/.env" });
import OpenAI from "openai";

// CONFIGURACIÓN
const BASE_PATH = "/opt/telephony-core/grabaciones_cpech";
const SOURCE_DIRS = [
  path.join(BASE_PATH, "ADMISION"),
  path.join(BASE_PATH, "ATENCION_GENERAL")
];
const TARGET_DIR = path.join(BASE_PATH, "STT");

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY no definida en el entorno");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Asegurar directorio destino
if (!fs.existsSync(TARGET_DIR)) {
  console.log(`📂 Creando directorio destino: ${TARGET_DIR}`);
  fs.mkdirSync(TARGET_DIR, { recursive: true });
}

async function transcribeFile(filePath) {
  const fileName = path.basename(filePath);
  const txtFileName = fileName.replace(path.extname(fileName), ".txt");
  const outputPath = path.join(TARGET_DIR, txtFileName);

  if (fs.existsSync(outputPath)) {
    console.log(`⏩ Saltando (ya existe): ${fileName}`);
    return;
  }

  const stat = fs.statSync(filePath);
  if (stat.size < 1000) {
    console.log(`⚠️ Archivo muy pequeño, saltando: ${fileName} (${stat.size} bytes)`);
    return;
  }

  console.log(`🎙️ Procesando: ${fileName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)...`);

  try {
    const start = Date.now();
    const result = await attemptTranscription(filePath);
    const duration = Date.now() - start;

    const text = (result.text || "").trim();
    fs.writeFileSync(outputPath, text, "utf8");

    console.log(`✅ Transcrito en ${duration}ms: ${fileName}`);
  } catch (err) {
    console.error(`❌ Error transcribiendo ${fileName}:`, err.message);
  }
}

async function attemptTranscription(filePath) {
  try {
    return await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "gpt-4o-transcribe",
      language: "es"
    });
  } catch (error) {
    // Detectar error de duración
    if (error.status === 400 && error.message.includes("longer than 1400 seconds")) {
      console.warn(`⚠️ Archivo excede límite de duración. Intentando recortar a 20min...`);
      return await transcribeTrimmed(filePath);
    }
    throw error;
  }
}

import { execSync } from "child_process";

async function transcribeTrimmed(originalPath) {
  const trimmedPath = originalPath.replace(".wav", "_trimmed.wav");

  try {
    // Recortar a 1200 segundos (20 min)
    // -y: sobrescribir si existe
    // -t 1200: duración
    // -c copy: sin recodificar (rápido)
    console.log(`✂️ Recortando ${originalPath} -> ${trimmedPath}`);
    execSync(`ffmpeg -y -i "${originalPath}" -t 1200 -c copy "${trimmedPath}"`, { stdio: "ignore" });

    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(trimmedPath),
      model: "gpt-4o-transcribe",
      language: "es"
    });

    return result;

  } finally {
    // Limpieza
    if (fs.existsSync(trimmedPath)) {
      fs.unlinkSync(trimmedPath);
      console.log(`🧹 Archivo temporal eliminado: ${trimmedPath}`);
    }
  }
}

async function processDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    console.warn(`⚠️ Directorio no existe: ${dirPath}`);
    return;
  }

  console.log(`\n📂 Escaneando directorio: ${dirPath}`);
  const files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith(".wav"));
  console.log(`📊 Encontrados ${files.length} archivos WAV`);

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    await transcribeFile(fullPath);
  }
}

async function run() {
  console.log("🚀 INICIANDO PROCESO BATCH STT CPECH");
  console.log("───────────────────────────────────");

  for (const dir of SOURCE_DIRS) {
    await processDirectory(dir);
  }

  console.log("\n🏁 Proceso finalizado.");
}

run().catch(err => {
  console.error("\n❌ ERROR FATAL:", err);
  process.exit(1);
});
