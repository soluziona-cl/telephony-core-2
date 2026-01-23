# ADR-003 — AUDIO_READY FINAL & STABLE

## Estado
**APROBADO · BLOQUEANTE · PRODUCCIÓN**

## Fecha
2026-01-22 (Post-Forensic Analysis)

## Contexto
Tras corregir el "Audio Plane" (ADR-002), persistía un bloqueo lógico en `ensureSTT` donde el sistema rechazaba el estado `READY` por considerarlo erróneamente "transitorio" o "esperando transición". Esto causaba que el audio físico estuviera perfecto, pero el STT abortara o reintentara con delay, causando latencia y timeouts de VAD.

## Decisión: Regla Única de Oro

Se establece la siguiente fórmula como **ÚNICA VERDAD** para iniciar STT:

```javascript
IF (SnoopContract.state === READY) AND (AudioPlane.checkPhysical() === OK) 
THEN
    ALLOW_STT()
ELSE
    BLOCK_STT()
```

### Prohibiciones Explícitas (Logic Fixes)
1.  **PROHIBIDO** tratar `READY` como estado transitorio. Si está READY, se usa.
2.  **PROHIBIDO** esperar una transición `READY -> READY`. El estado `READY` es terminal para la inicialización.
3.  **PROHIBIDO** "re-crear" o "re-esperar" un Snoop persistente. Si existe y está READY, se consume inmediatamente.

### Implementación en `ensureSTT`
El código debe reflejar exactamente esto:
```javascript
if (contract.state === SnoopState.READY) {
    if (!physicalOk) throw FATAL;
    // Si llegamos aquí, ES SEGURO.
    PROCEED(); // Sin log de espera, sin throw, sin return.
}
```

## Impacto
*   **Latency**: < 300ms (Eliminación de delays artificiales).
*   **Stability**: Eliminación de "Ghost Channels" y parálisis lógica.
*   **UX**: El usuario puede hablar inmediatamente después del saludo.

## Referencia
Este ADR reemplaza y consolida cualquier regla anterior sobre "Snoop Waits" o "Transition Guards".
