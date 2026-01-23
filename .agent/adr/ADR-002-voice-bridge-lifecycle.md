# ADR-002: Voice Bridge Lifecycle

**Fecha:** 2026-01-19  
**Estado:** Aceptado  
**Contexto:** VoiceBot Engine V3

---

## 🎯 Regla Fundamental

**El `voiceBridge` es el bus de audio del VoiceBot y vive desde el primer playback hasta `StasisEnd`.**

---

## 📋 Regla Obligatoria

### ✅ Contrato de Lifecycle

```
StasisStart
 └─ VoiceBridge (creado)
     ├─ Caller entra al bridge
     ├─ Playback BVDA
     ├─ LISTEN_RUT (caller SIGUE en bridge) ✅
     ├─ Snoop RX escucha audio del caller
     ├─ STT procesa audio
     └─ ... más fases ...
StasisEnd
 └─ VoiceBridge destruido
```

### ❌ Prohibiciones Absolutas

1. **NO destruir el bridge después del playback**
   - El bridge NO es solo para playback
   - El bridge es el bus de audio permanente

2. **NO remover el caller del bridge después del playback**
   - Asterisk puede hacerlo automáticamente
   - **Solución:** Verificar y re-insertar si es necesario

3. **NO crear/destruir el bridge en cada turno**
   - El bridge vive toda la sesión

---

## 🔧 Implementación

### Ubicación del Código

**Archivo:** `services/core/engine/voice-engine.js`

### Verificaciones Críticas

1. **Post-Playback Verification** (línea ~1764)
   ```javascript
   // Después de playWithBargeIn()
   if (voiceBridgeRef?.current) {
       const bridgeInfo = await voiceBridgeRef.current.get();
       if (!bridgeInfo.channels.includes(channel.id)) {
           // Re-insertar caller
           await voiceBridgeRef.current.addChannel({ channel: channel.id });
       }
   }
   ```

2. **Pre-LISTEN_RUT Verification** (línea ~1014)
   ```javascript
   // Antes de crear Snoop e inicializar STT
   if (voiceBridgeRef?.current) {
       const bridgeInfo = await voiceBridgeRef.current.get();
       if (!bridgeInfo.channels.includes(channel.id)) {
           // Re-insertar caller
           await voiceBridgeRef.current.addChannel({ channel: channel.id });
       }
   }
   ```

3. **StasisEnd Cleanup** (línea ~838)
   ```javascript
   channel.on("StasisEnd", async () => {
       if (voiceBridgeRef.current) {
           await voiceBridgeRef.current.destroy();
       }
   });
   ```

---

## 🧪 Validación

### Logs Esperados

✅ **Post-Playback:**
```
✅ [VOICE BRIDGE] Caller {id} permanece en bridge {bridgeId} después del playback
```

✅ **Pre-LISTEN_RUT:**
```
✅ [VOICE BRIDGE] Caller {id} confirmado en bridge {bridgeId} antes de LISTEN_RUT
```

### Asterisk CLI

Durante `LISTEN_RUT`, ejecutar:
```bash
bridge show all
```

**Debe mostrar:**
- Caller aún en el bridge
- Bridge activo
- **NO** debe aparecer `Channel PJSIP/... left 'simple_bridge'` hasta hangup

---

## 🚨 Por Qué Esto Es Crítico

### Problema Original

El caller salía del bridge después del playback, dejando el Snoop sin RTP:

```
Playback → Caller sale del bridge → Snoop sin audio → STT falla
```

### Solución

El bridge permanece activo durante toda la sesión:

```
Playback → Caller permanece en bridge → Snoop recibe RTP → STT funciona ✅
```

---

## 📌 Referencias

- **ADR-001:** Bridge Playback Alignment
- **Issue:** RUT Detection Failure (2026-01-19)
- **Root Cause:** Caller removed from bridge after playback

---

## ✅ Checklist de Implementación

- [x] Verificación post-playback implementada
- [x] Verificación pre-LISTEN_RUT implementada
- [x] Cleanup en StasisEnd implementado
- [x] Logs de diagnóstico agregados
- [x] ADR documentado

---

**Última actualización:** 2026-01-19
