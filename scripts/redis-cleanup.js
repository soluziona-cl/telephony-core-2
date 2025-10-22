import redis from "../lib/redis.js";
import { log } from "../lib/logger.js";

const keys = await redis.keys("activeCall:*");
for (const k of keys) {
    const data = JSON.parse(await redis.get(k));
    const age = Date.now() - new Date(data.lastUpdate).getTime();
    if (age > 3600000) { // > 1h
        await redis.del(k);
        log("info", `🧹 Redis cleanup: eliminado ${k}`);
    }
}
process.exit(0);
