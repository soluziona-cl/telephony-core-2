import { loadPrompt } from "./prompt-loader.js";

export function buildPrompt(promptFile, variables = {}, mode = "inbound") {
    let text = loadPrompt(promptFile, mode);

    Object.entries(variables).forEach(([key, value]) => {
        const regex = new RegExp(`{{${key}}}`, "g");
        text = text.replace(regex, value);
    });

    return text;
}
