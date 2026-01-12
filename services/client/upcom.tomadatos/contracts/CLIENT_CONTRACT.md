# CLIENT CONTRACT: UPCOM TOMADATOS

CLIENT_ID: upcom.tomadatos
RESPONSABILIDAD: Voicebot para toma de datos de contacto.

## 1. PRINCIPIO
Este cliente es una cápsula aislada. No importa ni depende de ningún otro cliente.

## 2. INTERFAZ CLIENTE → CORE

```typescript
interface ClientResponse {
  ttsText: string | null;     // null = silencio explícito
  nextPhase: string;          // fase siguiente
  action?: 'SET_STATE' | 'USE_ENGINE' | 'HANGUP';
  silent?: boolean;           // true = no hablar ni escuchar
  shouldHangup?: boolean;     // true = terminar llamada
}
```

## 3. REGLAS DE GOBERNANZA (HARDENING)
- **Prompt String**: El argumento `prompt` pasado al Engine DEBE ser siempre un STRING o NULL. Jamás un Array.
- **No Data Carrier**: El `prompt` NO debe usarse para transportar metadatos (ANI, DNIS, etc.). Usar `ctx` o `session state`.
- **Domain Guardrails**: El Adapter debe validar defensivamente sus inputs antes de llamar al Engine.

## 4. PROHIBICIONES
- Importar otro cliente.
- Depender de `services/voicebot_legacy`.
