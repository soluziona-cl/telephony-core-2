# Engine - Domain Contracts (`engine-domain.md`)

This document defines the strict contracts between the **Telephony Core Engine** and **Business Domains** (Clients).

## 1. Domain Entry Point

Every client domain MUST export a single entry point via `index.js`.
The engine invokes this function to process turns.

```javascript
// services/client/<CLIENT_ID>/index.js
export const domain = async (context) => { ... }
```

### Context Object (`ctx`)
Passed from Engine to Domain:
- `transcript` (string): User's spoken text (empty on Turn 0).
- `sessionId` (string): Unique call ID.
- `ani` (string): Caller ID.
- `dnis` (string): Called number.
- `state` (object): Current business state (accumulated).
- `botName` (string): Configuration identifier.

## 2. Domain Result (`ClientResponse`)

The Domain MUST return an object strictly adhering to this shape:

```typescript
interface ClientResponse {
  /**
   * Text to be spoken by TTS.
   * If null, the engine remains silent (unless system prompt required).
   * Supports 'sound:voicebot/filename' for static audio.
   */
  ttsText: string | null;

  /**
   * The next biological/logical phase of the conversation.
   * Used for state tracking and orchestration.
   */
  nextPhase: string;

  /**
   * Optional action directive for the engine.
   */
  action?: {
      type: 'SET_STATE' | 'END_CALL' | 'TRANSFER';
      payload?: any;
  };

  /**
   * If true, the engine will NOT wait for user input after TTS.
   * Use for creating multi-turn bot monologues or ending calls.
   */
  skipUserInput?: boolean; // Maps to 'silent' in legacy
  
  /**
   * Helper flag to signal immediate termination.
   */
  shouldHangup?: boolean;
}
```

## 3. Silence Policy Decision

The `SilencePolicy` evaluates silence and returns:

```typescript
interface SilenceDecision {
  action: 'prompt' | 'goodbye' | 'continue';
  count: number;
}
```

- **prompt**: Play a "Still there?" prompt.
- **goodbye**: Terminate call due to max silence.
- **continue**: Do nothing (wait more).

## 4. Prohibitions

1.  **Core Modification**: Domains must NOT modify core engine files.
2.  **Direct SQL in Core**: Domains must use `services/domains` or their own `sql/` folder.
3.  **Hiding Logic**: Use explicit state transitions.
