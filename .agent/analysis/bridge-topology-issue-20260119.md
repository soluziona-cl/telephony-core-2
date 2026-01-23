# 🔍 Diagnóstico: Problema de Topología de Bridges

**Fecha:** 2026-01-19  
**Sesión:** 1768837909.919  
**Problema:** Audio BVDA no se escucha aunque se reproduce correctamente

---

## ✅ CONFIRMACIÓN DEL PROBLEMA

### 1️⃣ El dominio SÍ ordena reproducir BVDA
```
[QUINTERO PHASED] INIT: Greeting -> LISTEN_RUT
action=PLAY_AUDIO
audio="quintero/greeting_sofia_2"
silent=true
skipInput=true
```
✅ **Confirmado:** El dominio hace exactamente lo correcto

### 2️⃣ El engine SÍ intenta reproducir el audio
```
▶️ Playing Audio: quintero/greeting_sofia_2 (BargeIn=false)
🔊 Reproduciendo (barge-in no): sound:voicebot/quintero/greeting_sofia_2
```
✅ **Confirmado:** El engine cree que está reproduciendo audio

### 3️⃣ El problema real: Topología de bridges incorrecta

**Evidencia del log:**
```
🌉 [VOICE BRIDGE] Creando bridge de voz para playback
🌉 [VOICE BRIDGE] Bridge de voz creado: 0c237cce-4452-47a2-a01f-c92d66152e94
🌉 [VOICE BRIDGE] Caller 1768837909.919 agregado al bridge 0c237cce-4452-47a2-a01f-c92d66152e94
```

**Luego:**
```
🌉 [BRIDGE] Bridge de captura creado 1733d6d8-3de8-415c-8c2e-9da3482d3935
🌊 [ExternalMedia] Created stt-1768837909.919-1768837910257
🌉 Wired Audio: 1768837909.920 -> Bridge -> stt-1768837909.919-1768837910257
```

**Problema identificado:**
- El caller queda en el **voice bridge** (0c237cce...)
- El **capture bridge** (1733d6d8...) se crea DESPUÉS del playback
- El playback se hace sobre el **canal directamente** (`channel.play()`), no sobre el bridge
- El canal puede no estar correctamente en el bridge cuando se reproduce

---

## 🎯 CAUSA RAÍZ (ROOT CAUSE)

**El engine está creando bridges separados para playback y captura, pero:**

1. El playback se ejecuta sobre el canal directamente (`channel.play()`)
2. El canal está en el voice bridge, pero el playback no se propaga correctamente
3. El capture bridge se crea DESPUÉS del INIT (lazy load), causando desincronización
4. El caller puede estar en el bridge, pero el audio no llega porque:
   - El bridge no está correctamente configurado para transmitir playback
   - O hay un problema de timing entre agregar al bridge y reproducir

---

## 📊 DIAGRAMA DE TOPOLOGÍA ACTUAL (PROBLEMÁTICA)

```
┌─────────────────────────────────────────────────────────┐
│                    VOICE BRIDGE                         │
│            (0c237cce-4452-47a2-a01f-c92d66152e94)       │
│                                                          │
│  ┌──────────────────┐                                   │
│  │ Caller Channel   │  ← Playback se hace AQUÍ          │
│  │ 1768837909.919   │     (channel.play())              │
│  └──────────────────┘                                   │
│                                                          │
│  ❌ Audio no se propaga correctamente                    │
└─────────────────────────────────────────────────────────┘

                    ⏱️ DESPUÉS (lazy load)

┌─────────────────────────────────────────────────────────┐
│                 CAPTURE BRIDGE                          │
│         (1733d6d8-3de8-415c-8c2e-9da3482d3935)          │
│                                                          │
│  ┌──────────────────┐    ┌──────────────────┐          │
│  │ Snoop Channel    │───▶│ ExternalMedia    │          │
│  │ 1768837909.920   │    │ stt-...-...       │          │
│  └──────────────────┘    └──────────────────┘          │
│                                                          │
│  ✅ STT funciona (recibe audio)                         │
└─────────────────────────────────────────────────────────┘
```

**Problema:** Dos bridges separados, el caller solo está en el voice bridge, pero el playback no se escucha.

---

## 🔧 SOLUCIÓN PROPUESTA

### Opción A: Bridge único maestro (RECOMENDADA)

**Arquitectura:**
```
┌─────────────────────────────────────────────────────────┐
│                    MASTER BRIDGE                        │
│              (mixing,dtmf_events)                        │
│                                                          │
│  ┌──────────────────┐                                   │
│  │ Caller Channel   │  ← Playback sobre bridge          │
│  │ 1768837909.919   │                                   │
│  └──────────────────┘                                   │
│                                                          │
│  ┌──────────────────┐    ┌──────────────────┐          │
│  │ Snoop Channel    │───▶│ ExternalMedia    │          │
│  │ 1768837909.920   │    │ stt-...-...       │          │
│  └──────────────────┘    └──────────────────┘          │
│                                                          │
│  ✅ Playback se escucha                                  │
│  ✅ STT funciona                                         │
└─────────────────────────────────────────────────────────┘
```

**Cambios necesarios:**
1. Crear UN SOLO bridge al inicio (en INIT o antes)
2. Agregar caller + Snoop + ExternalMedia al mismo bridge
3. Reproducir sobre el bridge, no sobre el canal directamente
4. O mantener playback sobre canal pero asegurar que el bridge esté correctamente configurado

### Opción B: Mantener bridges separados pero con cableado explícito

**Cambios necesarios:**
1. Asegurar que el caller esté en el voice bridge ANTES de reproducir
2. Verificar que el bridge esté en estado "Up" antes de playback
3. Reproducir sobre el bridge usando `bridge.play()` en lugar de `channel.play()`
4. Mantener caller en ambos bridges simultáneamente (mixing permite esto)

---

## 🚫 QUÉ NO ES EL PROBLEMA

- ❌ El archivo `quintero/greeting_sofia_2`
- ❌ El dominio Quintero
- ❌ La fase START_GREETING
- ❌ `silent=true` o `skipInput=true`
- ❌ El motor de TTS
- ❌ OpenAI
- ❌ Redis

**Todo eso está bien.**

---

## 📞 IMPACTO EN EL USUARIO

**Experiencia del usuario:**
1. Contesta la llamada
2. Silencio total (no escucha greeting)
3. Habla (el bot "lo oye" a nivel RTP)
4. El bot no responde (porque no detecta voz útil)
5. La llamada se corta

---

## 🔒 NOTA DE GOBERNANZA

**Este NO es un problema de dominio.**

Cualquier intento de "arreglarlo" desde Quintero sería incorrecto y rompería el aislamiento arquitectónico.

👉 **El problema está en la topología de bridges del engine, no en la lógica del bot.**

---

## ✅ PRÓXIMOS PASOS

1. **Decidir arquitectura:**
   - ¿Bridge único maestro?
   - ¿Bridges separados con cableado explícito?

2. **Validar comportamiento actual:**
   - Verificar si `channel.play()` funciona cuando el canal está en un bridge
   - Probar `bridge.play()` como alternativa

3. **Implementar corrección mínima:**
   - Sin romper otros bots
   - Sin afectar lógica de dominio
   - Solo topología de bridges

---

## 🔍 EVIDENCIA TÉCNICA

**Código relevante:**
- `services/core/engine/voice-engine.js:1317-1341` - Creación de voice bridge
- `services/core/engine/voice-engine.js:390-465` - Creación de capture bridge
- `services/core/engine/legacy/legacy-helpers.js:243-244` - Playback sobre canal

**Log clave:**
```
🌉 [VOICE BRIDGE] Bridge de voz creado: 0c237cce-4452-47a2-a01f-c92d66152e94
🌉 [VOICE BRIDGE] Caller 1768837909.919 agregado al bridge 0c237cce-4452-47a2-a01f-c92d66152e94
▶️ Playing Audio: quintero/greeting_sofia_2 (BargeIn=false)
🔊 [VB V3] Reproduciendo (barge-in no): sound:voicebot/quintero/greeting_sofia_2
✅ Playback completado: sound:voicebot/quintero/greeting_sofia_2
```

**Observación:** El playback se completa sin error, pero el usuario no escucha nada.
