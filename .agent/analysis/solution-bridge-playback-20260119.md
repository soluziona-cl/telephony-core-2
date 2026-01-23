# 🔧 Solución Técnica: Corrección de Playback en Bridge

**Fecha:** 2026-01-19  
**Problema:** Audio BVDA no se escucha aunque se reproduce  
**Causa:** Playback sobre canal en lugar de bridge

---

## 🧩 CONTEXTO HISTÓRICO (Causa Raíz Arquitectónica)

### Evolución del Sistema

**ANTES (Modelo Legacy - Estable):**
- ❇️ Un solo canal, sin bridges explícitos
- ❇️ `channel.play()` siempre funcionaba
- ❇️ Playback y audio del usuario compartían el mismo contexto
- ❇️ STT simple (grabación directa)

**DESPUÉS (Modelo Moderno - Actual):**
Se introdujeron 3 mejoras arquitectónicas legítimas:

1. **Voice Bridge** (para barge-in y control de mezcla)
2. **Capture Bridge + Snoop + ExternalMedia** (para STT realtime)
3. **STT Lazy Load** (inicialización diferida para performance)

**El Problema:**
- ✅ Las mejoras arquitectónicas son correctas y necesarias
- ❌ El mecanismo de playback quedó anclado al supuesto histórico
- ❌ `channel.play()` ya no es audible cuando el canal está dentro de un bridge
- ❌ El bridge es ahora el verdadero mezclador, no el canal

**Conclusión:**
No es un bug accidental, sino un efecto secundario arquitectónico. La modernización del engine no fue acompañada por la actualización del mecanismo de playback.

---

---

## 🎯 SOLUCIÓN PROPUESTA

### Opción 1: Reproducir sobre el bridge directamente (RECOMENDADA)

**Cambio en:** `services/core/engine/legacy/legacy-helpers.js`

**ANTES:**
```javascript
channel.play({ media }, playback)
```

**DESPUÉS:**
```javascript
// Si el canal está en un bridge, reproducir sobre el bridge
if (voiceBridgeRef?.current) {
    await voiceBridgeRef.current.play({ media }, playback);
} else {
    // Fallback: reproducir sobre canal si no hay bridge
    await channel.play({ media }, playback);
}
```

**Evidencia de que funciona:**
- `services/legacy/voicebot-engine_back.js:48` usa `bridge.play()` exitosamente
- `services/legacy/voicebot-engine_back.js:62` usa `bridge.play()` exitosamente

---

### Opción 2: Asegurar timing correcto (ALTERNATIVA)

**Cambio en:** `services/core/engine/voice-engine.js:1324-1341`

**ANTES:**
```javascript
// Asegurar que el canal caller esté en el bridge de voz
try {
    const bridgeInfo = await voiceBridgeRef.current.get();
    const isInBridge = Array.isArray(bridgeInfo.channels) && bridgeInfo.channels.includes(channel.id);
    if (!isInBridge) {
        await voiceBridgeRef.current.addChannel({ channel: channel.id });
        log("info", `🌉 [VOICE BRIDGE] Caller ${channel.id} agregado al bridge ${voiceBridgeRef.current.id}`);
    }
} catch (err) {
    log("warn", `⚠️ [VOICE BRIDGE] Error verificando/agregando canal: ${err.message}`);
}

// Inmediatamente después, reproducir
await playWithBargeIn(ari, channel, audioFile, openaiClient, { bargeIn: !silent });
```

**DESPUÉS:**
```javascript
// Asegurar que el canal caller esté en el bridge de voz
try {
    const bridgeInfo = await voiceBridgeRef.current.get();
    const isInBridge = Array.isArray(bridgeInfo.channels) && bridgeInfo.channels.includes(channel.id);
    if (!isInBridge) {
        await voiceBridgeRef.current.addChannel({ channel: channel.id });
        log("info", `🌉 [VOICE BRIDGE] Caller ${channel.id} agregado al bridge ${voiceBridgeRef.current.id}`);
        
        // 🛡️ CRÍTICO: Esperar a que el bridge esté completamente configurado
        await sleep(100); // Pequeña pausa para asegurar propagación
        
        // Verificar que el canal está realmente en el bridge
        const verifyBridge = await voiceBridgeRef.current.get();
        if (!verifyBridge.channels?.includes(channel.id)) {
            log("warn", `⚠️ [VOICE BRIDGE] Canal no confirmado en bridge, reintentando...`);
            await voiceBridgeRef.current.addChannel({ channel: channel.id });
            await sleep(100);
        }
    }
} catch (err) {
    log("warn", `⚠️ [VOICE BRIDGE] Error verificando/agregando canal: ${err.message}`);
}

// Reproducir sobre el bridge en lugar del canal
await playWithBargeInOnBridge(ari, voiceBridgeRef.current, audioFile, openaiClient, { bargeIn: !silent });
```

---

## 🔍 ANÁLISIS DE RIESGO

### Opción 1 (Bridge.play): ✅ BAJO RIESGO
- **Ventajas:**
  - Más robusto (reproduce directamente en el bridge)
  - Evita problemas de timing
  - Ya está probado en código legacy
  
- **Desventajas:**
  - Requiere pasar `voiceBridgeRef` a `playWithBargeIn`
  - Necesita fallback si no hay bridge

### Opción 2 (Timing fix): ⚠️ RIESGO MEDIO
- **Ventajas:**
  - Cambio mínimo
  - Mantiene estructura actual
  
- **Desventajas:**
  - Puede no resolver el problema si es arquitectural
  - Los `sleep()` son frágiles

---

## 📋 IMPLEMENTACIÓN RECOMENDADA

**Paso 1:** Implementar Opción 1 (bridge.play)

**Cambios necesarios:**

1. **Modificar `playWithBargeIn` para aceptar bridge opcional:**
```javascript
export async function playWithBargeIn(ari, channel, fileBaseName, openaiClient, options = {}, voiceBridgeRef = null) {
    // ... código existente ...
    
    const media = `sound:voicebot/${fileBaseName}`;
    const playback = ari.Playback();
    
    // 🎯 NUEVO: Reproducir sobre bridge si está disponible
    if (voiceBridgeRef?.current) {
        log("info", `🔊 [VB V3] Reproduciendo sobre bridge ${voiceBridgeRef.current.id}: ${media}`);
        voiceBridgeRef.current
            .play({ media }, playback)
            .catch((err) => {
                // Fallback a canal si falla
                log("warn", `⚠️ [VB V3] Fallback a canal: ${err.message}`);
                return channel.play({ media }, playback);
            });
    } else {
        // Fallback: reproducir sobre canal
        channel.play({ media }, playback)
            .catch((err) => {
                // ... manejo de error ...
            });
    }
}
```

2. **Actualizar llamada en `applyDomainResult`:**
```javascript
await playWithBargeIn(ari, channel, audioFile, openaiClient, { bargeIn: !silent }, voiceBridgeRef);
```

---

## ✅ VALIDACIÓN

**Tests a realizar:**

1. ✅ Playback se escucha en llamada inbound
2. ✅ STT sigue funcionando correctamente
3. ✅ Barge-in funciona cuando está habilitado
4. ✅ No se rompen otros bots (legacy)
5. ✅ No hay regresiones en playback de TTS

---

## 🚫 QUÉ NO HACER

- ❌ NO modificar lógica de dominio
- ❌ NO cambiar fases de Quintero
- ❌ NO tocar configuración de STT
- ❌ NO crear nuevos bridges innecesarios
- ❌ NO eliminar bridges existentes sin validar
- ❌ NO usar timing hacks (sleep) como solución permanente
- ❌ NO revertir las mejoras arquitectónicas (bridges + STT moderno)

---

## 📊 IMPACTO ESPERADO

**Antes:**
- Playback se ejecuta pero no se escucha
- Usuario escucha silencio

**Después:**
- Playback se ejecuta sobre bridge
- Usuario escucha greeting correctamente
- STT sigue funcionando

---

## 🔒 GOBERNANZA

**Este cambio es:**
- ✅ Arquitectural (engine core)
- ✅ No afecta dominio
- ✅ Backward compatible (fallback a canal)
- ✅ Mínimo y enfocado
- ✅ Alineación necesaria con arquitectura moderna

**Aprobación requerida:**
- Revisión de arquitectura
- Test en ambiente de desarrollo
- Validación con otros bots

**Nota importante:**
Este cambio NO es un parche, es una **alineación arquitectónica necesaria** que cierra el ajuste transversal faltante tras la modernización del engine (bridges + STT moderno).
