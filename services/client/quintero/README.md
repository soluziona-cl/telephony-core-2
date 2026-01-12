# Client Capsule: Quintero (`voicebot_quintero`)

This directory contains the **isolated** runtime configuration and logic for the Quintero voicebot.
Strategy: **Shared-Nothing Architecture**.

## Structure

- **inbound/**: Entry points and adapters for inbound calls.
- **outbound/**: Logic for outbound dialing (campaigns).
- **bot/**: Core bot state machine, phases, and flow logic.
- **openai/**: Prompts, tool definitions, and model configuration.
- **n8n/**: Webhook client and integration logic (actions).
- **sql/**: Direct database queries (if any - prefer n8n).
- **voice/**: Voice activity detection (VAD), silence handling, and interrupts.
- **contracts/**: Interface definitions (TypeScript interfaces or JSDoc) ensuring the bot meets the Engine Agreement.

## Rules

1. **No External Imports**: Do not import from `../../voicebot/shared` unless strictly utility (lodash, date-fns).
2. **Self-Contained**: All prompts and business logic must reside here.
3. **Fail-Closed**: If a dependency is missing, the bot should fail safely, not degrade silently.
