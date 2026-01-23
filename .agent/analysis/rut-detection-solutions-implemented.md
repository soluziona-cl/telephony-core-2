# ✅ Soluciones Implementadas: Detección de RUT

**Fecha:** 2026-01-19  
**Problema:** Sistema no detecta RUT cuando el usuario lo indica  
**Causa Raíz:** Snoop RX se destruye antes de que el STT pueda usarlo + STT se reinicializa múltiples veces

---

## 🎯 Soluciones Implementadas

### 1️⃣ Protección del Snoop RX durante LISTEN_RUT

**Archivo:** `services/core/ari/ari-listener.js`

**Cambios:**
- Agregada protección en `findAndHangupRelatedChannels` para NO destruir el Snoop durante fases LISTEN_*
- Detección mejorada de canales Snoop en búsqueda por linkedId
- Verificación de fase actual desde Redis antes de destruir canales

**Código clave:**
```javascript
// 🎯 SOLUCIÓN 1: Proteger Snoop RX durante LISTEN_RUT
const currentPhase = await redis.get(`phase:${linkedId}`);
const listenPhases = ['LISTEN_RUT', 'LISTEN_OPTION', 'LISTEN_CONFIRMATION'];
const isListenPhase = currentPhase && listenPhases.includes(currentPhase);

if (isListenPhase && source === 'snoop' && chId.startsWith('Snoop/')) {
    log("info", `🔒 [SNOOP PROTECTION] Protegiendo Snoop ${chId} durante fase ${currentPhase} (NO destruir)`);
    continue; // ✅ Saltar este canal, no destruirlo
}
```

---

### 2️⃣ NO reinicializar STT por TURN/NO_INPUT

**Archivo:** `services/core/engine/voice-engine.js`

**Cambios:**
- Agregado tracking de fase en la que se inicializó el STT (`sttPhaseInitialized`)
- El STT solo se inicializa UNA vez por fase LISTEN_*
- NO se reinicializa en TURN/NO_INPUT si ya está inicializado para la misma fase

**Código clave:**
```javascript
let sttPhaseInitialized = null; // 🎯 Track en qué fase se inicializó el STT

const ensureSTT = async () => {
    const currentPhase = domainContext.state?.rutPhase;
    const listenPhases = ['LISTEN_RUT', 'LISTEN_OPTION', 'LISTEN_CONFIRMATION'];
    const isListenPhase = listenPhases.includes(currentPhase);
    
    // 🎯 SOLUCIÓN 2: NO reinicializar STT si ya está inicializado en fase LISTEN_*
    if (sttInitialized) {
        if (isListenPhase && sttPhaseInitialized === currentPhase) {
            log("debug", `🔒 [STT] STT ya inicializado para fase ${currentPhase}, NO reinicializando`);
            return; // ✅ STT ya está vivo, no reinicializar
        }
    }
    
    // ... inicialización del STT ...
    
    sttInitialized = true;
    sttPhaseInitialized = currentPhase; // 🎯 Marcar en qué fase se inicializó
    snoopChannelId = audioSource !== channel.id ? audioSource : null; // 🎯 Guardar Snoop ID
}
```

---

### 3️⃣ VAD debe escuchar el Snoop, no el canal base

**Archivo:** `services/core/engine/voice-engine.js`

**Cambios:**
- Prioridad para usar Snoop guardado durante inicialización
- VAD usa el Snoop si está disponible, no el canal principal
- Logging mejorado para indicar qué canal se está usando

**Código clave:**
```javascript
// 🎯 SOLUCIÓN 3: VAD debe escuchar el Snoop, no el canal base
let sttChannelId = snoopChannelId; // 🎯 Prioridad 1: Snoop guardado durante inicialización
if (!sttChannelId) {
    sttChannelId = (await redis.get(`stt:channel:${linkedId}`)) || channel.id; // 🎯 Prioridad 2: Redis o canal principal
}

log("info", `🎧 [STT] Escuchando (Streaming) en canal ${sttChannelId} ${snoopChannelId ? '(Snoop protegido)' : '(canal principal)'}`);
```

---

### 4️⃣ Persistencia de fase en Redis

**Archivo:** `services/core/engine/voice-engine.js`

**Cambios:**
- Guardar fase actual en Redis cuando cambia
- Permite que el cleanup verifique si estamos en LISTEN_RUT
- Protección del Snoop basada en fase actual

**Código clave:**
```javascript
// 🎯 SOLUCIÓN 1: Guardar fase en Redis para protección del Snoop durante cleanup
if (domainResult.state.rutPhase) {
    await redis.set(`phase:${linkedId}`, domainResult.state.rutPhase, { EX: 3600 });
    log("debug", `💾 [PHASE] Fase guardada en Redis: ${domainResult.state.rutPhase} para linkedId ${linkedId}`);
}
```

---

## 📋 Checklist de Validación

Cuando esto esté bien, deberías ver en logs:

❌ **NO más:**
- `Initializing STT Stack (x veces)` (múltiples veces)
- `Canal snoop no existe` durante LISTEN_RUT
- `VAD no detectó voz` cuando el usuario habla

✔️ **SÍ:**
- `Snoop creado una vez`
- `STT inicializado una vez` (para fase LISTEN_RUT)
- `STT ya inicializado para fase LISTEN_RUT, NO reinicializando`
- `[SNOOP PROTECTION] Protegiendo Snoop` durante cleanup
- `VAD detectó voz`
- `Incremental delta recibido`

---

## 🧠 Regla Mental Clave

**Snoop RX es al STT lo que el canal es al usuario.**

Si el Snoop muere, el STT queda sordo, aunque todo "parezca" activo.

---

## 🎯 Lifecycle Correcto Implementado

1. **START_GREETING**: Snoop creado, STT NO inicializado
2. **Transición**: Playback finaliza, STT pre-warm (si nextPhase=LISTEN_RUT)
3. **LISTEN_RUT**: 
   - STT inicializado UNA vez
   - Snoop protegido (NO se destruye)
   - VAD escucha el Snoop
   - NO reinicialización en TURN/NO_INPUT
4. **Finalización**: Snoop destruido solo cuando RUT detectado o timeout final

---

## 📌 Próximos Pasos

1. Reiniciar el servicio: `sudo systemctl restart telephony-core`
2. Probar una llamada y verificar:
   - STT se inicializa una sola vez
   - Snoop se mantiene vivo durante LISTEN_RUT
   - VAD detecta voz del usuario
   - RUT se captura correctamente
