# Client Capsule: Upcom Tomadatos

Isolated runtime for the Upcom data collection bot.

## Structure
- **bot/**: Contains the State Machine (`index.js`).
- **inbound/**: Adapter for the Engine.
- **n8n/**: (Not currently used, simulated webhooks in bot/index.js).

## Logic
Simple sequential flow: Name -> RUT -> Phone -> End.
