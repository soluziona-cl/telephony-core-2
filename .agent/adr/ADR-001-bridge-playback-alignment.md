# ADR-001: Alineación de Playback con Arquitectura de Bridges

**Fecha:** 2026-01-19  
**Estado:** Aceptado  
**Decisión:** Reproducir audio sobre Voice Bridge cuando esté disponible, con fallback a canal

---

## Contexto

El engine evolucionó a una arquitectura con bridges persistentes (Voice Bridge + Capture Bridge) para soportar:
- Barge-in real
- STT realtime con Snoop + ExternalMedia
- Control de mezcla de audio

Sin embargo, el mecanismo de playback quedó usando `channel.play()`, que ya no es audible cuando el canal está dentro de un bridge. El bridge es ahora el verdadero mezclador de audio.

## Problema

**Síntoma:** Audio BVDA (y otros playbacks) no se escucha aunque se reproduce correctamente.

**Causa raíz:** Playback se ejecuta sobre el canal (`channel.play()`) cuando el canal está dentro de un bridge. El audio no se propaga al caller porque el bridge es el punto de verdad del audio.

**Evidencia:**
- Log muestra: `▶️ Playing Audio: quintero/greeting_sofia_2` → `✅ Playback completado`
- Usuario no escucha nada
- STT funciona correctamente (usa Capture Bridge)

## Decisión

**Reproducir audio sobre el Voice Bridge cuando esté disponible, con fallback a canal para backward compatibility.**

### Implementación

1. **Modificar `playWithBargeIn`** para aceptar `voiceBridgeRef` opcional
2. **Usar `bridge.play()`** si el bridge existe
3. **Fallback a `channel.play()`** si no hay bridge o si falla

### Código

```javascript
// Si existe Voice Bridge, el playback DEBE ir por el bridge
if (voiceBridgeRef?.current) {
    await voiceBridgeRef.current.play({ media }, playback);
} else {
    // Fallback legacy (backward compatibility)
    await channel.play({ media }, playback);
}
```

## Consecuencias

### Positivas

✅ Audio se escucha correctamente  
✅ Alineación con arquitectura moderna  
✅ Backward compatible (fallback a canal)  
✅ No rompe bots legacy  
✅ No afecta dominio ni fases  
✅ No afecta STT

### Negativas

⚠️ Requiere pasar `voiceBridgeRef` a `playWithBargeIn`  
⚠️ Cambio en función core (requiere testing exhaustivo)

## Alternativas Consideradas

### Opción 1: Bridge.play (Elegida) ✅
- **Ventajas:** Soluciona causa raíz, robusto, ya probado en legacy
- **Desventajas:** Requiere modificar función core

### Opción 2: Timing fixes (sleep)
- **Ventajas:** Cambio mínimo
- **Desventajas:** Frágil, no soluciona causa raíz, puede fallar bajo carga

### Opción 3: Revertir bridges
- **Ventajas:** Ninguna
- **Desventajas:** Perdería todas las mejoras arquitectónicas

## Validación

**Tests requeridos:**
1. ✅ Playback se escucha en llamada inbound
2. ✅ STT sigue funcionando correctamente
3. ✅ Barge-in funciona cuando está habilitado
4. ✅ No se rompen otros bots (legacy)
5. ✅ No hay regresiones en playback de TTS
6. ✅ Fallback funciona cuando no hay bridge

**Logs esperados:**
```
🔊 [PLAYBACK] Bridge.play (0c237cce-...) → sound:voicebot/quintero/greeting_sofia_2
```

## Referencias

- Análisis forense: `.agent/analysis/log-analysis-20260119-125157.md`
- Diagnóstico topología: `.agent/analysis/bridge-topology-issue-20260119.md`
- Solución técnica: `.agent/analysis/solution-bridge-playback-20260119.md`
- Contexto arquitectónico: `.agent/analysis/architectural-evolution-context.md`

## Notas

- Este cambio NO es un parche, es una **alineación arquitectónica necesaria**
- El dominio NO debe absorber esto
- El engine debe asumir que el bridge es el punto de verdad del audio
- Código legacy que usa `bridge.play()`: `services/legacy/voicebot-engine_back.js:48,62`

---

**Aprobado por:** Arquitectura  
**Implementado en:** `services/core/engine/legacy/legacy-helpers.js`  
**Fecha de implementación:** 2026-01-19
