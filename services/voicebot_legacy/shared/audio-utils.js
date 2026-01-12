import fs from "fs";
import { spawn } from "child_process";
import { randomUUID } from "crypto";

export async function convertWavToUlaw(wavBuffer) {
    const id = randomUUID();
    const wavPath = `/tmp/${id}.wav`;
    const ulawPath = `/tmp/${id}.ulaw`;

    fs.writeFileSync(wavPath, wavBuffer);

    return new Promise((resolve) => {
        const ff = spawn("ffmpeg", [
            "-y",
            "-i", wavPath,
            "-ar", "8000",
            "-ac", "1",
            "-f", "mulaw",
            ulawPath
        ]);

        ff.on("close", () => resolve(ulawPath));
    });
}
