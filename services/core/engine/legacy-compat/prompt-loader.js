import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Esto nos da el directorio REAL donde está prompt-loader.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadPrompt(promptName, mode = "inbound") {

    // Ruta correcta ABSOLUTA
    const fullPath = path.join(
        __dirname,
        "../../../voicebot_legacy",        // salir a services/voicebot_legacy
        mode,        // inbound / outbound
        "prompts",
        promptName
    );

    if (!fs.existsSync(fullPath)) {
        throw new Error(`❌ No se encontró el prompt: ${fullPath} (mode=${mode})`);
    }

    return fs.readFileSync(fullPath, "utf8");
}
