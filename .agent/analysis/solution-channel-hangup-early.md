# 🔧 Propuesta de Solución: Manejo de Hangups Tempranos y Robustez del Sistema

**Fecha:** 2026-01-19  
**Problema:** Canal se cuelga antes de que el sistema pueda configurarlo, causando "Channel not found"  
**Prioridad:** CRÍTICA

---

## 🚨 PROBLEMA IDENTIFICADO

### Síntomas Observados

1. **Canal se cuelga durante protección inicial:**
   - Protección de 1000ms iniciada
   - Usuario cuelga a los 419ms o 161ms
   - Sistema intenta agregar canal al bridge → "Channel not found"

2. **Playback no se ejecuta:**
   - Canal no existe cuando se intenta reproducir audio
   - Sistema omite playback sin error claro

3. **STT no se inicializa:**
   - Canal Snoop no existe cuando se intenta agregar al Capture Bridge
   - Loop infinito de intentos fallidos

### Evidencia del Log

```
16:34:59.286Z [INFO] 🛡️ Protegiendo inicio de llamada para canal 1768851299.949, esperando 1000ms...
16:34:59.419Z [INFO] 🔚 Fin de llamada LinkedID=1768851299.949 / Channel=1768851299.949
16:35:00.338Z [ERROR] ❌ [VOICE BRIDGE] Error verificando/agregando canal: {"message": "Channel not found"}
16:35:00.341Z [DEBUG] 🔇 [VB V3] No se pudo verificar estado del canal: {"message": "Channel not found"}, omitiendo playback
```

---

## 🎯 CAUSA RAÍZ

**Race Condition entre:**
1. Protección inicial de 1000ms
2. Hangup del usuario (puede ocurrir en cualquier momento)
3. Configuración de bridges y playback

**El sistema asume que el canal estará disponible después de la protección, pero no valida su existencia antes de operaciones críticas.**

---

## ✅ SOLUCIONES PROPUESTAS

### 1. Validación de Estado del Canal Antes de Operaciones Críticas

**Archivo:** `services/core/engine/voice-engine.js`

**Cambio:**
- Verificar estado del canal ANTES de agregarlo al bridge
- Manejar gracefully si el canal ya no existe
- No intentar playback si el canal no está disponible

**Código:**

```javascript
// ANTES de agregar canal al bridge
try {
    // 🛡️ VALIDACIÓN CRÍTICA: Verificar que el canal existe y está activo
    const channelState = await channel.get();
    if (!channelState || channelState.state === 'Down') {
        log("warn", `⚠️ [VOICE BRIDGE] Canal ${channel.id} no disponible (estado: ${channelState?.state || 'null'}), omitiendo bridge setup`);
        return; // Salir gracefully sin error
    }
    
    // Proceder con agregar al bridge solo si el canal está activo
    const bridgeInfo = await voiceBridgeRef.current.get();
    // ... resto del código
} catch (err) {
    if (err.message && err.message.includes('Channel not found')) {
        log("warn", `⚠️ [VOICE BRIDGE] Canal ${channel.id} ya no existe (hangup temprano), omitiendo bridge setup`);
        return; // Salir gracefully
    }
    throw err; // Re-lanzar otros errores
}
```

---

### 2. Verificación de Canal en playWithBargeIn

**Archivo:** `services/core/engine/legacy/legacy-helpers.js`

**Cambio:**
- La verificación actual está bien, pero necesita mejor manejo de errores
- No fallar silenciosamente, sino retornar estado claro

**Código Mejorado:**

```javascript
// Mejorar la verificación existente
try {
    const channelState = await channel.get();
    if (!channelState || channelState.state === 'Down') {
        log("warn", `🔇 [VB V3] Canal no disponible para playback (estado: ${channelState?.state || 'null'}), omitiendo`);
        if (openaiClient) openaiClient.isPlaybackActive = false;
        return { reason: "channel_down", skipped: true }; // ✅ Retornar estado claro
    }
} catch (err) {
    if (err.message && err.message.includes('Channel not found')) {
        log("warn", `🔇 [VB V3] Canal ${channel.id} ya no existe (hangup temprano), omitiendo playback`);
        if (openaiClient) openaiClient.isPlaybackActive = false;
        return { reason: "channel_not_found", skipped: true }; // ✅ Retornar estado claro
    }
    // Re-lanzar otros errores
    throw err;
}
```

---

### 3. Protección Inteligente con Verificación Continua

**Archivo:** `services/core/ari/ari-listener.js`

**Cambio:**
- Reducir protección de 1000ms a 500ms
- Verificar estado del canal durante la protección
- Salir early si el canal se cuelga

**Código:**

```javascript
// Protección inteligente con verificación continua
const callStartTime = Date.now();
const PROTECTION_MS = 500; // ✅ Reducido de 1000ms a 500ms
const CHECK_INTERVAL_MS = 100; // Verificar cada 100ms

log("info", `🛡️ Protegiendo inicio de llamada para canal ${channel.id}, esperando ${PROTECTION_MS}ms...`);

let elapsed = 0;
while (elapsed < PROTECTION_MS) {
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
    elapsed = Date.now() - callStartTime;
    
    // ✅ Verificar si el canal sigue activo
    try {
        const channelState = await channel.get();
        if (!channelState || channelState.state === 'Down') {
            log("warn", `⚠️ Canal ${channel.id} se colgó durante protección (${elapsed}ms), cancelando inicialización`);
            return; // Salir early
        }
    } catch (err) {
        if (err.message && err.message.includes('Channel not found')) {
            log("warn", `⚠️ Canal ${channel.id} ya no existe (${elapsed}ms), cancelando inicialización`);
            return; // Salir early
        }
    }
}

log("info", `🛡️ Fin de protección para ${channel.id} (${elapsed}ms elapsed)`);
```

---

### 4. Manejo Robusto de STT Initialization

**Archivo:** `services/core/engine/voice-engine.js` (STT initialization)

**Cambio:**
- Verificar que el canal Snoop existe antes de agregarlo al Capture Bridge
- No crear loops infinitos si el canal no existe
- Limitar reintentos

**Código:**

```javascript
// En la inicialización de STT
try {
    // 🛡️ VALIDACIÓN: Verificar que el canal Snoop existe
    if (audioChannelId) {
        try {
            const snoopChannel = ari.Channel().get({ channelId: audioChannelId });
            const snoopState = await snoopChannel.get();
            if (!snoopState || snoopState.state === 'Down') {
                log("warn", `⚠️ [STT INIT] Canal Snoop ${audioChannelId} no disponible, omitiendo inicialización STT`);
                return; // Salir gracefully
            }
        } catch (err) {
            if (err.message && err.message.includes('Channel not found')) {
                log("warn", `⚠️ [STT INIT] Canal Snoop ${audioChannelId} ya no existe, omitiendo inicialización STT`);
                return; // Salir gracefully
            }
            throw err;
        }
    }
    
    // Proceder con STT initialization solo si el canal existe
    // ...
} catch (err) {
    // Manejo de errores mejorado
    if (err.message && err.message.includes('Channel not found')) {
        log("warn", `⚠️ [STT INIT] Canal no encontrado durante inicialización, omitiendo STT`);
        return; // No reintentar infinitamente
    }
    throw err;
}
```

---

### 5. Listener de Hangup Temprano

**Archivo:** `services/core/ari/ari-listener.js`

**Cambio:**
- Detectar hangups durante la protección
- Cancelar inicialización si el canal se cuelga antes de tiempo

**Código:**

```javascript
// Agregar listener de hangup antes de la protección
let hangupDetected = false;
const hangupListener = (event, hungupChannel) => {
    if (hungupChannel.id === channel.id) {
        hangupDetected = true;
        log("warn", `⚠️ Hangup detectado para canal ${channel.id} durante protección`);
    }
};

ari.on("ChannelHangupRequest", hangupListener);

try {
    // Protección con verificación de hangup
    const callStartTime = Date.now();
    const PROTECTION_MS = 500;
    
    while (Date.now() - callStartTime < PROTECTION_MS) {
        if (hangupDetected) {
            log("warn", `⚠️ Cancelando inicialización: canal ${channel.id} se colgó durante protección`);
            return; // Salir early
        }
        await new Promise(r => setTimeout(r, 100));
    }
} finally {
    // Limpiar listener
    ari.removeListener("ChannelHangupRequest", hangupListener);
}
```

---

## 📊 IMPACTO ESPERADO

### Positivo

✅ **Eliminación de errores "Channel not found"**  
✅ **Manejo graceful de hangups tempranos**  
✅ **No más loops infinitos de STT**  
✅ **Mejor experiencia de usuario (sin errores en logs)**  
✅ **Sistema más robusto ante condiciones de carrera**

### Negativo

⚠️ **Protección reducida de 1000ms a 500ms** (puede afectar detección de silencio, pero es aceptable)  
⚠️ **Más verificaciones = ligero overhead** (mínimo, aceptable)

---

## 🎯 PRIORIZACIÓN DE IMPLEMENTACIÓN

### Fase 1: Crítica (Implementar Inmediatamente)

1. ✅ **Validación de canal antes de agregar al bridge** (Solución 1)
2. ✅ **Mejora de verificación en playWithBargeIn** (Solución 2)
3. ✅ **Manejo robusto de STT initialization** (Solución 4)

### Fase 2: Mejora (Implementar Después)

4. ⚠️ **Protección inteligente con verificación continua** (Solución 3)
5. ⚠️ **Listener de hangup temprano** (Solución 5)

---

## 🔍 VALIDACIÓN

### Tests Requeridos

1. ✅ Canal se cuelga durante protección → Sistema sale gracefully
2. ✅ Canal se cuelga antes de playback → Playback se omite sin error
3. ✅ Canal Snoop no existe → STT no se inicializa, no hay loop
4. ✅ Canal normal funciona → Sin regresiones

### Logs Esperados

```
✅ [VOICE BRIDGE] Canal no disponible (estado: Down), omitiendo bridge setup
✅ [VB V3] Canal ya no existe (hangup temprano), omitiendo playback
✅ [STT INIT] Canal Snoop ya no existe, omitiendo inicialización STT
```

---

## 📚 REFERENCIAS

- Logs de error: `2026-01-19T19:35:00.338Z [ERROR] ❌ [VOICE BRIDGE] Error verificando/agregando canal`
- Código actual: `services/core/engine/voice-engine.js:1324-1364`
- Código actual: `services/core/engine/legacy/legacy-helpers.js:140-152`
