# Voice Engine Refactored Architecture

## Overview

The voice engine has been refactored from a 2,495-line monolith into modular, responsibility-based components. This document describes the new architecture.

## Directory Structure

```
services/core/engine/
├── core/
│   └── session-context.js       # Session state encapsulation
├── policies/
│   ├── silence-policy.js        # Silence detection & fail-closed
│   ├── hold-policy.js           # HOLD state with music-on-hold
│   └── goodbye-policy.js        # Graceful call termination
├── ari/
│   ├── channel-control.js       # Channel operations (MOH, hangup)
│   ├── playback.js              # Audio playback with barge-in
│   └── recording.js             # Audio recording & validation
├── legacy-compat/               # Legacy helpers (unchanged)
├── config.js                    # Configuration
└── voice-engine.js              # Main engine (to be refactored)
```

## Module Responsibilities

### Core

#### `session-context.js`
**Purpose**: Encapsulate all session-level mutable state

**Exports**: `SessionContext` class

**Key Methods**:
- `resetSilence()` - Reset silence counters when voice detected
- `incrementSilence()` - Increment silence counters
- `markVoiceDetected()` - Mark voice as detected
- `terminate()` - Mark session as terminated (idempotent)
- `getSummary()` - Get session summary for logging

**State Managed**:
- Identity (linkedId, ANI, DNIS)
- Lifecycle (active, terminated)
- Silence tracking (silenceCount, consecutiveSilences)
- HOLD state (inHold, holdEnteredAt)
- Conversation history
- Audio metrics (hasSpeech, successfulTurns)

---

### Policies

#### `silence-policy.js`
**Purpose**: Manage silence detection and fail-closed behavior

**Exports**: `SilencePolicy` class

**Configuration**:
```javascript
{
  maxSilentTurns: 3,        // Max consecutive silences before goodbye
  failClosed: true          // Enable fail-closed safety
}
```

**Key Methods**:
- `evaluate(session, voiceDetected)` → `{ action: 'continue' | 'prompt' | 'goodbye', reason?, message? }`

**Behavior**:
- First silence → `action: 'prompt'` (play "still there?")
- Max silences + fail-closed → `action: 'goodbye'` (end call)
- Voice detected → reset counters

---

#### `hold-policy.js`
**Purpose**: Manage HOLD state with music-on-hold for silent phases

**Exports**: `HoldPolicy` class

**Configuration**:
```javascript
{
  enableHold: false,              // Feature flag (disabled by default)
  enterOnFirstSilence: true,      // Enter HOLD on first silence in silent phase
  maxHoldDurationMs: 30000,       // 30 seconds max
  musicClass: 'default'           // MOH class from musiconhold.conf
}
```

**Key Methods**:
- `shouldEnter(session, currentPhase, PHASES)` → `boolean`
- `enter(session, channelControl)` → Start MOH
- `shouldExit(session, voiceDetected)` → `boolean`
- `exit(session, channelControl)` → Stop MOH

**Behavior**:
- Only activates in silent phases (phases that don't require user input)
- Exits on voice detection or timeout
- Gracefully handles MOH failures

---

#### `goodbye-policy.js`
**Purpose**: Manage graceful call termination

**Exports**: `GoodbyePolicy` class

**Configuration**:
```javascript
{
  goodbyePhrases: [...],      // Phrases that trigger goodbye
  postAudioDelayMs: 2000      // Wait time after final audio
}
```

**Key Methods**:
- `shouldEnd(assistantResponse)` → `boolean`
- `finalize(session, channelControl, playbackModule, finalMessage)` → Graceful termination
- `terminate(session, channelControl, reason)` → Quick termination (errors/timeouts)

**Behavior**:
- Detects goodbye phrases in assistant response
- Plays final message if provided
- Waits for audio completion before hangup
- Marks session as terminated to prevent post-hangup operations

---

### ARI

#### `channel-control.js`
**Purpose**: Isolate all Asterisk channel operations

**Exports**: `ChannelControl` class

**Key Methods**:
- `startMOH(musicClass)` → Start music-on-hold
- `stopMOH()` → Stop music-on-hold
- `hangup()` → Hangup channel (idempotent)
- `isAlive()` → Check if channel is alive
- `getState()` → Get channel state
- `playSilence(durationSeconds)` → Play silence (keep-alive)

**Safety**:
- All methods are idempotent
- Gracefully handles "channel not found" errors
- Logs benign errors as debug, not error

---

#### `playback.js`
**Purpose**: Manage audio playback with barge-in detection

**Exports**: `PlaybackModule` class

**Configuration**:
```javascript
{
  playbackTimeoutMs: 30000,
  talkingDebounceMs: 300,
  voicebotPath: '/var/lib/asterisk/sounds/voicebot'
}
```

**Key Methods**:
- `playWithBargeIn(channel, fileBaseName, openaiClient, options)` → `{ reason }`
- `playFinalMessage(channel, fileBaseName, openaiClient)` → Non-interruptible playback
- `playStatic(channel, fileBaseName)` → Simple static playback

**Behavior**:
- Verifies channel is alive before playback
- Detects barge-in via `ChannelTalkingStarted` events
- Cancels OpenAI response on barge-in
- Handles timeouts and errors gracefully

---

#### `recording.js`
**Purpose**: Manage audio recording operations

**Exports**: `RecordingModule` class

**Configuration**:
```javascript
{
  maxRecordingMs: 15000,
  silenceThresholdSec: 2,
  minWavSizeBytes: 6000,
  recordingsPath: '/var/spool/asterisk/recording'
}
```

**Key Methods**:
- `recordUserTurn(channel, turnNumber)` → `{ ok, reason, path?, recId?, duration? }`
- `waitForFile(path, timeoutMs, intervalMs)` → Wait for file to exist
- `isValidRecording(path)` → Validate recording file

**Behavior**:
- Records with silence detection
- Validates file size (filters WebRTC noise)
- Handles timeouts and errors
- Returns detailed result object

---

## Integration Pattern (Phase 4 - Pending)

Once the Engine Runner is implemented, the main loop will look like:

```javascript
// Bootstrap
const session = new SessionContext(linkedId, ani, dnis);
const channelControl = new ChannelControl(ari, channel);
const playback = new PlaybackModule(ari, config.audio);
const recording = new RecordingModule(config.audio);

const silencePolicy = new SilencePolicy(config.engine);
const holdPolicy = new HoldPolicy({ enableHold: false }); // Feature flag
const goodbyePolicy = new GoodbyePolicy();

// Main loop (simplified)
while (session.active && turnNumber < MAX_TURNS) {
  // 1. Check HOLD entry
  if (holdPolicy.shouldEnter(session, session.currentPhase, PHASES)) {
    await holdPolicy.enter(session, channelControl);
  }

  // 2. Record user input
  const recordResult = await recording.recordUserTurn(channel, turnNumber);

  // 3. Evaluate silence
  if (!recordResult.ok) {
    const silenceResult = silencePolicy.evaluate(session, false);
    if (silenceResult.action === 'goodbye') {
      await goodbyePolicy.finalize(session, channelControl, playback, silenceResult.message);
      break;
    }
    continue;
  }

  // 4. Exit HOLD if voice detected
  if (holdPolicy.shouldExit(session, true)) {
    await holdPolicy.exit(session, channelControl);
  }

  // 5. Process with domain (existing logic)
  // ...

  // 6. Play response
  await playback.playWithBargeIn(channel, responseFile, openaiClient, { bargeIn: true });

  // 7. Check goodbye
  if (goodbyePolicy.shouldEnd(assistantResponse)) {
    await goodbyePolicy.finalize(session, channelControl, playback, null);
    break;
  }
}
```

## Benefits

✅ **Reduced Complexity**: Each module has a single, clear responsibility
✅ **Testability**: Modules can be unit tested in isolation
✅ **HOLD Feature**: Easy to enable/disable via feature flag
✅ **Maintainability**: Changes are localized to specific modules
✅ **Safety**: Idempotent operations prevent post-hangup errors
✅ **Extensibility**: New policies can be added without touching existing code

## Governance Compliance

- ✅ All modules are in `services/core/engine/` (CORE)
- ✅ No client-specific logic in any module
- ✅ No modifications to domain contracts
- ✅ Respects ENGINE_GOVERNANCE.md principles
- ✅ Engine remains "idiotic" - policies make decisions, not the engine

## Next Steps

1. **Phase 4**: Create `engine-runner.js` to orchestrate modules
2. **Phase 5**: Extract telemetry/logging
3. **Phase 6**: Move deprecated functions to `legacy/`
4. **Phase 7**: Test with Quintero bot and document
