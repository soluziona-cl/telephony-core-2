
import { resolveDomain } from './voicebot_legacy/router/voicebot-domain-router.js';

async function testRouter() {
    console.log("🧪 Starting Migration Verification Test...\n");

    // Test 1: Legacy Mode (Default)
    console.log("🔹 Test 1: Default Mode (Legacy)");
    delete process.env.CLIENT_ROUTING_MODE;
    const legacyBot = await resolveDomain('voicebot_identity_quintero');
    const legacyName = legacyBot?.name || (legacyBot ? 'IdentityDomain' : 'Unknown');
    console.log(`   Result: ${legacyBot ? 'RESOLVED' : 'FAILED'} (Type: ${typeof legacyBot})`);

    // Test 2: Client Mode + Quintero
    console.log("\n🔹 Test 2: Client Mode (Quintero Capsule)");
    process.env.CLIENT_ROUTING_MODE = 'client';
    const capsuleBot = await resolveDomain('voicebot_identity_quintero');

    // The adapter is a default export function 'quinteroAdapter'
    const isAdapter = capsuleBot?.name === 'quinteroAdapter';
    console.log(`   Result: ${capsuleBot ? 'RESOLVED' : 'FAILED'} - Is Adapter? ${isAdapter ? '✅ YES' : '❌ NO'} (${capsuleBot?.name})`);

    // Test 3: Client Mode + Other Bot (Should fallback to legacy)
    console.log("\n🔹 Test 3: Client Mode (Other Bot -> Sales)");
    const salesBot = await resolveDomain('voicebot_sales');
    console.log(`   Result: ${salesBot ? 'RESOLVED' : 'FAILED'} (Type: ${typeof salesBot})`);

    // Test 4: Client Mode + Upcom
    console.log("\n🔹 Test 4: Client Mode (Upcom Capsule)");
    // Upcom mode string: voicebot_upcom_tomadatos
    const upcomBot = await resolveDomain('voicebot_upcom_tomadatos');

    const isUpcomAdapter = upcomBot?.name === 'upcomAdapter';
    console.log(`   Result: ${upcomBot ? 'RESOLVED' : 'FAILED'} - Is Adapter? ${isUpcomAdapter ? '✅ YES' : '❌ NO'} (${upcomBot?.name})`);

    console.log("\n✅ Verification Complete.");
}

async function verifyImmutability() {
    console.log("\n🔒 Verifying Architectural Immutability...");
    const { execSync } = await import('child_process');
    try {
        // Grep for references to services/voicebot in services/core (excluding README/docs if any)
        // We look for 'from ...voicebot' or 'require(...voicebot)'
        // This is a naive check but effective
        const cmd = 'grep -rE "from.*voicebot|require.*voicebot" /opt/telephony-core/services/core';
        const output = execSync(cmd, { encoding: 'utf-8' });

        if (output.trim().length > 0) {
            console.error("❌ CRTICAL FAILURE: Found active imports to services/voicebot in Core!");
            console.error(output);
            process.exit(1);
        }
    } catch (e) {
        // grep returns exit code 1 if no matches found, which is GOOD
        if (e.status === 1) {
            console.log("✅ PASS: No active imports to services/voicebot found in Core.");
        } else {
            console.error("⚠️ Grep check failed:", e.message);
        }
    }
}

testRouter().then(verifyImmutability).catch(console.error);
