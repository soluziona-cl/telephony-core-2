# CLIENT CONTRACT: QUINTERO

CLIENT_ID: quintero
RESPONSABILIDAD: Voicebot de confirmación de citas médicas.

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
- **Source of Truth**: Todo prompt hablado debe residir en este directorio o ser generado dinámicamente aquí.
- **Explicit Turn 0**: El bot DEBE tener una fase de arranque explícita (e.g., `START_GREETING`) que reproduzca el saludo inicial ANTES de cualquier fase de escucha. Prohibido "inferir" el saludo dentro de fases de escucha (`WAIT_*`).

## 4. PROHIBICIONES
- Importar otro cliente.
- Acceder a `services/voicebot_legacy` excepto para migraciones.
- Modificar `services/core` para lógica de negocio.
