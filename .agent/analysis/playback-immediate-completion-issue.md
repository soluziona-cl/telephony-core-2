# 🔍 Análisis: Playback se Completa Inmediatamente (14ms)

**Fecha:** 2026-01-19 15:02  
**Problema:** `bridge.play()` se ejecuta pero el playback termina casi instantáneamente

---

## 📊 EVIDENCIA DEL LOG

```
🔊 [PLAYBACK] Bridge.play (2d347457-2434-4811-9601-8671636ce9a7) → sound:voicebot/quintero/greeting_sofia_2
✅ Playback completado: sound:voicebot/quintero/greeting_sofia_2
```

**Tiempo transcurrido:** ~14ms (demasiado rápido para un archivo de audio)

---

## 🎯 POSIBLES CAUSAS

### 1. Archivo no existe
**Evidencia:**
- `ls -la /var/lib/asterisk/sounds/voicebot/quintero/greeting_sofia_2.*` → No encontrado
- `ls -la /var/lib/asterisk/sounds/voicebot/quintero/` → Directorio vacío

**Impacto:** Si el archivo no existe, Asterisk puede completar el playback inmediatamente sin error visible.

### 2. Bridge sin canales activos
**Evidencia:**
- El canal se agrega al bridge: `🌉 [VOICE BRIDGE] Caller 1768845740.933 agregado al bridge`
- Pero el playback se ejecuta inmediatamente después

**Posible problema:** El canal podría no estar completamente en el bridge cuando se reproduce.

### 3. Formato de archivo incorrecto
**Evidencia:**
- El código usa: `sound:voicebot/quintero/greeting_sofia_2`
- Asterisk espera el nombre sin extensión

**Posible problema:** El archivo podría no estar en el formato esperado por Asterisk.

---

## 🔧 CAMBIOS IMPLEMENTADOS

### 1. Verificación de bridge antes de reproducir
```javascript
const bridgeInfo = await voiceBridgeRef.current.get();
const hasChannels = Array.isArray(bridgeInfo.channels) && bridgeInfo.channels.length > 0;
```

### 2. Delay después de agregar canal
```javascript
await new Promise(resolve => setTimeout(resolve, 100));
```

### 3. Logging adicional
- Estado del bridge antes de reproducir
- Duración del playback
- Advertencia si playback < 100ms

---

## 📋 PRÓXIMOS PASOS

1. **Verificar archivo:**
   - Confirmar que existe en `/var/lib/asterisk/sounds/voicebot/quintero/`
   - Verificar formato (wav, gsm, etc.)
   - Verificar permisos

2. **Verificar logs de Asterisk:**
   - Buscar errores de archivo no encontrado
   - Verificar eventos de playback

3. **Probar con archivo conocido:**
   - Usar un archivo que sabemos que existe
   - Verificar si el problema es específico de este archivo

---

## 🚨 ACCIÓN INMEDIATA

**El archivo `greeting_sofia_2` no existe en el sistema.**

Esto explica por qué el playback se completa inmediatamente. Asterisk no puede reproducir un archivo que no existe, pero puede completar el playback sin error visible.

**Solución:** Verificar si el archivo debe generarse o si está en otra ubicación.
