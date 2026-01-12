# 🔧 Fix: Duplicación de TTS en Fases Silenciosas

## 🐛 Problema Identificado

**Los audios se duplicaban porque las fases silenciosas devolvían `ttsText` y luego el engine también generaba TTS.**

### Evidencia del Log

```
🗣️ [SILENT PHASE] Generando TTS para: "Un momento por favor, estoy buscando disponibilidad..."
🗣️ [TTS Explicit] Sintetizando: "Un momento por favor, estoy buscando disponibilidad..."
```

**El mismo texto se sintetizaba DOS veces.**

## ✅ Solución Implementada

### Regla de Oro

**Las fases silenciosas NO deben devolver `ttsText`.**

**El TTS debe estar en la fase ANTERIOR que transiciona a la fase silenciosa.**

### Cambios Realizados

#### 1. `parse-specialty.js` (Fase ANTERIOR)

**ANTES:**
```javascript
return {
  ttsText: null, // Se generará en CHECK_AVAILABILITY
  nextPhase: 'CHECK_AVAILABILITY',
  ...
};
```

**DESPUÉS:**
```javascript
const staticMessage = "Un momento por favor, estoy buscando disponibilidad para la especialidad solicitada.";

return {
  ttsText: staticMessage, // ✅ TTS en fase anterior, NO en fase silenciosa
  nextPhase: 'CHECK_AVAILABILITY',
  ...
};
```

#### 2. `check-availability.js` (Fase SILENCIOSA)

**ANTES:**
```javascript
return {
  ttsText: staticMessage, // ❌ TTS en fase silenciosa
  nextPhase: 'INFORM_AVAILABILITY',
  skipUserInput: true,
  ...
};
```

**DESPUÉS:**
```javascript
return {
  ttsText: null, // ✅ Fase silenciosa: NO TTS
  nextPhase: 'INFORM_AVAILABILITY',
  skipUserInput: true,
  ...
};
```

#### 3. `inform-availability.js` (Corrección)

**ANTES:**
```javascript
return {
  ttsText: ttsMessage,
  nextPhase: 'CONFIRM_APPOINTMENT',
  skipUserInput: true, // ❌ Incorrecto: necesita esperar confirmación
  ...
};
```

**DESPUÉS:**
```javascript
return {
  ttsText: ttsMessage,
  nextPhase: 'CONFIRM_APPOINTMENT',
  skipUserInput: false, // ✅ NO es fase silenciosa: espera confirmación del usuario
  ...
};
```

## 📊 Flujo Correcto

```
PARSE_SPECIALTY
  ↓
  ttsText: "Un momento por favor..."
  ↓
CHECK_AVAILABILITY (silenciosa)
  ↓
  ttsText: null
  skipUserInput: true
  ↓
INFORM_AVAILABILITY (conversacional)
  ↓
  ttsText: "Hay una hora disponible..."
  skipUserInput: false (espera confirmación)
  ↓
CONFIRM_APPOINTMENT
  ↓
FINALIZE (silenciosa, última fase)
  ↓
  ttsText: "Su hora quedó agendada..."
  skipUserInput: true (cierra llamada)
```

## ✅ Checklist de Validación

- [x] `parse-specialty.js` devuelve TTS antes de transicionar a fase silenciosa
- [x] `check-availability.js` devuelve `ttsText: null` (fase silenciosa)
- [x] `inform-availability.js` NO tiene `skipUserInput: true` (espera confirmación)
- [x] `finalize.js` puede tener TTS (última fase, cierra llamada)

## 🎯 Resultado

**Ahora:**
- ✅ TTS se reproduce UNA sola vez
- ✅ Fases silenciosas no generan TTS duplicado
- ✅ Flujo conversacional correcto
- ✅ Sin duplicación de audio

**Listo para producción.** 🎯

