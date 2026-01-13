# Phase 4 Integration Strategy

## Objective

Integrate the `EngineRunner` and all extracted modules into `voice-engine.js` **without breaking production**.

## Risk Assessment

**Risk Level**: 🔴 **HIGH** - Modifies main engine loop

**Mitigation Strategy**: Incremental integration with feature flags

---

## Integration Approach: Hybrid Mode

Instead of replacing the entire `voice-engine.js` immediately, we'll use a **hybrid approach**:

### Option A: Feature Flag Integration (RECOMMENDED)

Add a feature flag to enable the new modular engine while keeping the legacy code intact:

```javascript
const USE_MODULAR_ENGINE = process.env.USE_MODULAR_ENGINE === 'true' || false;

if (USE_MODULAR_ENGINE) {
  // New modular engine
  await runModularEngine(session, channel, openaiClient, ...);
} else {
  // Legacy monolithic engine (current production code)
  await runLegacyEngine(...);
}
```

**Benefits**:
- ✅ Zero risk to production
- ✅ Can test in parallel
- ✅ Easy rollback
- ✅ Gradual migration

**Drawbacks**:
- ⚠️ Temporary code duplication
- ⚠️ Requires cleanup after migration

---

### Option B: Direct Replacement (HIGHER RISK)

Replace the main loop directly with `EngineRunner`:

**Benefits**:
- ✅ Clean codebase immediately
- ✅ No duplication

**Drawbacks**:
- ❌ High risk of regression
- ❌ Difficult rollback
- ❌ All-or-nothing deployment

---

## Recommended Plan: Option A (Feature Flag)

### Step 1: Add Configuration

Add to `config-base.js`:

```javascript
engine: {
  maxTurns: 20,
  maxSilentTurns: 4,
  useModularEngine: false,  // Feature flag
  hold: {
    enabled: false,          // HOLD feature flag
    enterOnFirstSilence: true,
    maxHoldDurationMs: 30000,
    musicClass: 'default'
  }
}
```

### Step 2: Create Modular Engine Bootstrap

Add new function to `voice-engine.js`:

```javascript
async function runModularEngine(ari, channel, ani, dnis, linkedId, promptFile, domainContext) {
  // 1. Create session
  const session = new SessionContext(linkedId, ani, dnis);

  // 2. Create modules
  const channelControl = new ChannelControl(ari, channel);
  const playback = new PlaybackModule(ari, config.audio);
  const recording = new RecordingModule(config.audio);
  
  const silencePolicy = new SilencePolicy(config.engine);
  const holdPolicy = new HoldPolicy(config.engine.hold);
  const goodbyePolicy = new GoodbyePolicy();

  // 3. Create runner
  const runner = new EngineRunner({
    silencePolicy,
    holdPolicy,
    goodbyePolicy,
    playback,
    recording,
    channelControl
  }, {
    maxTurns: config.engine.maxTurns,
    PHASES
  });

  // 4. Create legacy state objects (for compatibility)
  const conversationState = { active: true, startTime: new Date(), history: [] };
  const audioState = { hasSpeech: false, successfulTurns: 0 };
  const businessState = { /* ... */ };

  // 5. Run loop
  await runner.runLoop(
    session,
    channel,
    openaiClient,
    domainProcessor,
    conversationState,
    audioState,
    businessState
  );

  // 6. Finalize
  await finalizeCallStorage(ari, channel, ani, dnis, linkedId, conversationState, audioState, businessState);
}
```

### Step 3: Add Feature Flag Check

Modify `startVoiceBotSessionV3`:

```javascript
export async function startVoiceBotSessionV3(ari, channel, ani, dnis, linkedId, promptFile, domainContext = null) {
  log('info', `🤖[VB ENGINE V3] Starting session...`);

  // Feature flag check
  if (config.engine.useModularEngine) {
    log('info', '🔧 [ENGINE] Using MODULAR engine');
    return runModularEngine(ari, channel, ani, dnis, linkedId, promptFile, domainContext);
  }

  // Legacy engine (current production code continues here)
  log('info', '🔧 [ENGINE] Using LEGACY engine');
  // ... existing code ...
}
```

### Step 4: Testing Plan

1. **Test with flag OFF** (default):
   - Verify Quintero bot works exactly as before
   - No regressions

2. **Test with flag ON**:
   - Enable: `USE_MODULAR_ENGINE=true npm start`
   - Test Quintero bot full flow
   - Verify identical behavior

3. **Test HOLD feature** (when ready):
   - Enable both flags
   - Test HOLD activation in silent phases

### Step 5: Migration Path

Once modular engine is proven stable:

1. Set `useModularEngine: true` as default
2. Monitor production for 1 week
3. Remove legacy code
4. Clean up feature flags

---

## Domain Processor Adapter

The `EngineRunner` expects a `domainProcessor` function. We need to wrap the existing logic:

```javascript
async function createDomainProcessor(openaiClient, ari, channel, linkedId) {
  return async function domainProcessor(recordResult, session, conversationState, audioState, businessState) {
    // 1. Process audio with OpenAI
    const responseBaseName = await processUserTurnWithOpenAI(recordResult.path, openaiClient);
    
    // 2. Get transcript and response
    const transcript = await waitForTranscript(openaiClient);
    const assistantResponse = openaiClient.lastAssistantResponse || '';

    // 3. Run business logic (existing code)
    await runBusinessLogic(transcript, assistantResponse, businessState, conversationState, ari, channel, openaiClient, linkedId);

    // 4. Return standardized response
    return {
      responseFile: responseBaseName,
      assistantResponse: assistantResponse,
      transcript: transcript,
      critical: /rut|confirmar|registrado/i.test(assistantResponse),
      nextPhase: businessState.rutPhase || session.currentPhase
    };
  };
}
```

---

## Rollback Plan

If issues arise:

1. **Immediate**: Set `USE_MODULAR_ENGINE=false` in environment
2. **Code**: Revert `voice-engine.js` to previous commit
3. **Verification**: Test Quintero bot

---

## Success Criteria

✅ Quintero bot works identically with modular engine
✅ No "Channel not found" errors
✅ Silence detection works
✅ Goodbye flow is clean
✅ HOLD feature can be enabled without breaking existing flow

---

## Next Steps

1. Implement feature flag in `config-base.js`
2. Create `runModularEngine()` function
3. Create `domainProcessor` adapter
4. Add feature flag check to `startVoiceBotSessionV3()`
5. Test with flag OFF (baseline)
6. Test with flag ON (new engine)
7. Document results
