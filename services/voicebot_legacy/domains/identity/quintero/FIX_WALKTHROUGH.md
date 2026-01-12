# 🏁 Walkthrough: V3-Compatible Guardrails & Fixes

## 🎯 Objetivo
Resolución de incidencias críticas bajo arquitectura V3 y mejora de flujos de negocio:
1. **Doble TTS**: Eliminación de rebote de audio via Engine Guardrail.
2. **Missing Audio**: Corrección de silencio en `CHECK_AVAILABILITY`.
3. **Silent Recording**: Bloqueo de grabación en fases marcadas como silenciosas.
4. **Invalid Fallback**: Prevención de alucinaciones en sesiones sin identidad.
5. **Silence & Fallback Hardening**: Matriz de silencio para CONFIRM y bloqueo global de fallback.
6. **Engine Lifecycle Hardening**: Eliminación de "zombie turns" y duplicidad en fase `COMPLETE`.
7. **Strict Mode Playback**: Prevención de reproducción `voicebot/null`.
8. **Double Streaming (Hallucination)**: `playStillTherePrompt` ahora es estático.
9. **Double Streaming (Fall-through)**: Corrección estructural para evitar que Modo Estricto ejecute playback genérico.
10. **Confirmation Lost Fix**: Bypass Anti-Replay en reintentos y mejora del clasificador "Y es correcto".
11. **No Availability Retry Flow**: Nueva fase para ofrecer alternativas cuando no hay horas.
12. **Final Confirmation Fix**: Corrección de mensaje final y eliminación de bucle de confirmación.
13. **English Confirmation Support**: Mejora del clasificador para soportar afirmaciones en inglés ("He is correct") mediante normalización semántica.

## 🛠️ Cambios Implementados

### 1. `state-machine.js` (Bug Fix)
- **Infinite Loop Fix**: Se eliminó un caso duplicado de `FINALIZE` que apuntaba incorrectamente a `informAvailability`, lo que causaba un bucle infinito `FINALIZE` -> `CONFIRM_APPOINTMENT`.

### 2. `handlers/finalize.js` (UX Update)
- **Mensaje Final**: Se actualizó el texto TTS para ser explícito: "Su hora ha sido confirmada..." seguido de una despedida formal.

### 3. `handlers/check-availability.js` (Dominio Improvements)
- **Retry Flow (Split Turns)**: Implementación de patrón de dos turnos para consistencia UX.
    - **Turno 1 (CheckAvailability)**: Output Only (`silent: false`, `ttsText="No encontré hours..."`).
    - **Turno 2 (OfferAlternatives)**: Input Only (Espera "Sí/No").
    - **UX Update**: Se mejoró el TTS para guiar explícitamente: "Si desea consultar por otra, diga sí. Si no, diga no."
- **Skip User Input Fix**: Se asegura `skipUserInput: true` en errores técnicos para evitar grabaciones fantasma.

### 4. `handlers/offer-alternatives.js` (Nuevo Handler)
- **Lógica de Decisión**:
    - **Sí/Otra**: Resetea intentos y redirige a `ASK_SPECIALTY` (mantiene RUT).
    - **Otro RUT**: Deniega cambio por seguridad ("Llame nuevamente") y cuelga.
    - **No**: Despedida y cuelga.

### 6. Latency Optimization (Prefetch)
- **Problem**: Delay between `ASK_SPECIALTY` and `CHECK_AVAILABILITY` due to webhook latency + TTS transition.
- **Solution**:
    - **Prefetch**: Trigger `GET_NEXT_AVAILABILITY` in background immediately after parsing specialty.
    - **Zero-TTS Transition**: Removed "Un momento por favor" to transition instantly while prefetch runs.
    - **Cache**: Implemented explicit request caching in `webhook-client.js`.

## 📜 Regla UX de Gobernanza: Flujos sin Resultado

Para cualquier fase que no produzca un resultado positivo (NO_AVAILABILITY, NO_MATCH, EMPTY_RESULT), se DEBE seguir este patrón:

1.  **Turno 1 (Notificación)**: Informar explícitamente el resultado y las opciones disponibles ("Diga sí para X, diga no para Y").
2.  **Turno 2 (Escucha)**: Abrir el micrófono solo después de haber guiado al usuario.

**Prohibido**: Abrir escucha sin contexto o esperar que el usuario "adivine" qué hacer.

## 🧪 Diagrama de Solución (Final Message)

```mermaid
graph TD
    A[Confirm Appointment] -->|Yes| B[Finalize]
    B -->|Webhook OK| C[Play: "Su hora ha sido confirmada..."]
    C --> D[Hangup (synchronous)]
```
