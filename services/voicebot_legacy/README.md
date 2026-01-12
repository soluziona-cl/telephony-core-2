# ⚠️ LEGACY MODULE - READ ONLY

**This directory is in the process of deprecation.**

> [!CAUTION]
> **DO NOT CREATE NEW FILES HERE.**
> **DO NOT MODIFY LOGIC HERE.**
> **DO NOT ADD NEW FEATURES HERE.**

## Migration Status
The architecture is moving to a modular structure:
- **Infrastructure (Engine, ARI, Telephony)**: Moved to `/services/core/`
- **Business Logic (Bots)**: Moved to `/services/client/` (formerly `services/dominio/`)
- **Routing**: Handled by `/services/router/client-entry-router.js`

## Allowable Changes
Only critical bug fixes that cannot be addressed in the new architecture are permitted here, and they must be heavily documented.

## Future State
This directory will be moved to `services/legacy/voicebot` once all active dependencies are removed.
