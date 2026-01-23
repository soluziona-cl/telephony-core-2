# 🧩 Contexto de Evolución Arquitectónica: Playback en Bridges

**Fecha:** 2026-01-19  
**Propósito:** Documentar la evolución arquitectónica que causó el problema de playback

---

## 📊 ANTES vs DESPUÉS

### 🟢 ANTES (Modelo Legacy - Estable)

**Arquitectura:**
```
Caller Channel
   │
   ├─ channel.play()   ✅ audible
   └─ STT (grabación directa o simple)
```

**Características:**
- ❇️ Un solo canal
- ❇️ Sin bridges explícitos
- ❇️ `channel.play()` siempre funcionaba
- ❇️ Playback y audio del usuario compartían el mismo contexto
- ❇️ STT simple (grabación directa)

**Supuesto válido:**
```javascript
channel.play({ media })  // "esto siempre se escucha"
```

---

### 🔵 DESPUÉS (Modelo Moderno - Actual)

**Arquitectura:**
```
Caller ──▶ Voice Bridge ──▶ (playback debería ir aquí)
   │
   └─▶ Snoop ──▶ Capture Bridge ──▶ ExternalMedia ──▶ STT
```

**Mejoras introducidas (todas legítimas y necesarias):**

#### 1️⃣ Voice Bridge
**Motivo:**
- Soportar barge-in
- Controlar mezcla
- Preparar arquitectura multi-media

**Cambio:**
```
Caller ──▶ Voice Bridge
```

**Impacto oculto:**
- El caller ya no es el endpoint final del audio → el bridge lo es

#### 2️⃣ Capture Bridge + Snoop + ExternalMedia
**Motivo:**
- STT realtime
- Snooping RX-only
- No interferir con audio del usuario

**Cambio:**
```
Snoop ──▶ Capture Bridge ──▶ ExternalMedia ──▶ STT
```

**Impacto oculto:**
- Se separa audio de salida (bot) y audio de entrada (usuario)
- Aparecen dos bridges con responsabilidades distintas

#### 3️⃣ STT Lazy Load
**Motivo:**
- Performance
- Evitar grabaciones innecesarias
- Escalabilidad

**Cambio:**
- El Capture Bridge se crea después del greeting
- El Voice Bridge existe antes

**Impacto oculto:**
- El playback ocurre cuando el sistema ya está bridgeado
- Pero sigue usando lógica antigua (`channel.play()`)

---

## 🚨 EL PUNTO DE RUPTURA

### Supuesto Legacy que Dejó de Ser Válido

```javascript
channel.play({ media })  // "esto siempre se escucha"
```

**Este supuesto ya NO es cierto cuando:**
- ✅ El canal está dentro de un bridge
- ✅ El bridge es el verdadero mezclador
- ✅ Existen múltiples bridges activos

**Resultado:**
- El playback se ejecuta, pero no se propaga al caller
- El audio "se pierde" en el canal, no llega al bridge

---

## 🎯 CAUSA RAÍZ (Formulada Correctamente)

> La modernización del engine (bridges + snoop + externalMedia + lazy STT) no fue acompañada por la actualización del mecanismo de playback, que siguió usando `channel.play()` en lugar de `bridge.play()`.

**Esto NO es:**
- ❌ Un error de concepto
- ❌ Un bug accidental
- ❌ Un problema de dominio

**Esto ES:**
- ✅ Una omisión de ajuste transversal
- ✅ Un efecto secundario arquitectónico
- ✅ Una señal de madurez del sistema

---

## ✅ POR QUÉ APARECIÓ "AHORA" Y NO ANTES

**Antes no existía esta topología:**
- ❌ No había bridges persistentes
- ❌ No había separación de audio RX/TX
- ❌ No había ExternalMedia activo
- ❌ No había STT realtime siempre vivo

**El sistema evolucionó, pero el playback quedó anclado a un supuesto antiguo.**

---

## 🧭 LECTURA CORRECTA DEL PROBLEMA

**Esto es una señal de madurez del sistema:**
- ✔️ La arquitectura va en la dirección correcta
- ⚠️ Faltó cerrar un ajuste transversal
- 🛡️ El dominio NO debe absorber esto
- 🧠 El engine debe asumir que el bridge es el punto de verdad

---

## 🔧 LA SOLUCIÓN (Alineación Arquitectónica)

**No es un parche, es una alineación arquitectónica necesaria:**

```javascript
// ANTES (supuesto legacy)
channel.play({ media }, playback)

// DESPUÉS (alineado con arquitectura moderna)
if (voiceBridgeRef?.current) {
    voiceBridgeRef.current.play({ media }, playback)  // ✅ Bridge es el punto de verdad
} else {
    channel.play({ media }, playback)  // ✅ Fallback para backward compatibility
}
```

---

## 🚫 QUÉ NO CAUSÓ EL PROBLEMA

**No fue provocado por:**
- ❌ Quintero
- ❌ BVDA
- ❌ Fases
- ❌ silent / skipInput
- ❌ Incremental STT
- ❌ Redis
- ❌ OpenAI
- ❌ Archivos de audio

**Todo eso funciona correctamente.**

---

## 📚 REFERENCIAS

- `services/legacy/voicebot-engine_back.js:48` - Ejemplo de `bridge.play()` funcionando
- `services/core/engine/voice-engine.js:1317-1341` - Creación de Voice Bridge
- `services/core/engine/voice-engine.js:390-465` - Creación de Capture Bridge
- `services/core/engine/legacy/legacy-helpers.js:243-244` - Playback sobre canal (legacy)

---

## 🔒 GOBERNANZA

**Este cambio:**
- ✅ NO toca dominio
- ✅ NO cambia fases
- ✅ NO rompe otros bots
- ✅ Es backward compatible
- ⚠️ SÍ es engine-core (requiere cuidado, pero es correcto)

**El dominio NO debe absorber esto. El engine debe asumir que el bridge es el punto de verdad.**
