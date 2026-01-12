# 🔧 Ajustes de Orquestación Conversacional - Implementados

## ✅ Cambios Implementados

### 1. Fases Silenciosas (SILENT_PHASES)

**Fases que NO escuchan al usuario:**
- `CHECK_AVAILABILITY`
- `INFORM_AVAILABILITY`
- `FINALIZE`

**Comportamiento:**
- ❌ NO se transcribe audio del usuario
- ❌ NO se procesa transcript
- ❌ NO se usa "¿Sigues ahí?" en estas fases
- ✅ Solo se ejecuta lógica del dominio (webhooks, TTS)

**Implementación:**
```javascript
const SILENT_PHASES = [
  'CHECK_AVAILABILITY',
  'INFORM_AVAILABILITY',
  'FINALIZE'
];

const isSilentPhase = SILENT_PHASES.includes(businessState.rutPhase);

if (isSilentPhase) {
  transcript = ""; // Ignorar audio del usuario
  // Continuar con lógica del dominio
}
```

---

### 2. "¿Sigues ahí?" - TTS Estático

**ANTES (❌ Incorrecto):**
```javascript
const audioBuffer = await openaiClient.sendSystemText("¿Sigues ahí?");
// OpenAI genera respuesta libre → causa respuestas fuera de contexto
```

**DESPUÉS (✅ Correcto):**
```javascript
const staticText = "¿Sigue en línea? Por favor, dígame sí o no.";
const audioBuffer = await openaiClient.sendTextAndWait(staticText);
// TTS controlado, sin improvisación
```

**Reglas:**
1. NUNCA usar `sendSystemText` para "¿Sigues ahí?"
2. Siempre usar `sendTextAndWait` con texto fijo
3. Omitir en fases silenciosas

**Implementación:**
```javascript
async function playStillTherePrompt(ari, channel, openaiClient, currentPhase = null) {
  const SILENT_PHASES = ['CHECK_AVAILABILITY', 'INFORM_AVAILABILITY', 'FINALIZE'];
  
  if (currentPhase && SILENT_PHASES.includes(currentPhase)) {
    return false; // Omitir en fases silenciosas
  }
  
  const staticText = "¿Sigue en línea? Por favor, dígame sí o no.";
  const audioBuffer = await openaiClient.sendTextAndWait(staticText);
  // ... reproducir audio
}
```

---

### 3. Bloqueo de Regresiones de Fase

**Regresiones Permitidas:**
- `CONFIRM` → `WAIT_BODY` (Usuario rechaza RUT)
- `CONFIRM_APPOINTMENT` → `ASK_DATE` (Usuario rechaza hora)
- `PARSE_SPECIALTY` → `ASK_SPECIALTY` (Especialidad no identificada)

**Regresiones Bloqueadas:**
- `FINALIZE` → `CONFIRM` ❌
- `INFORM_AVAILABILITY` → `WAIT_BODY` ❌
- `CHECK_AVAILABILITY` → `CONFIRM` ❌

**Implementación:**
```javascript
const PHASE_ORDER = {
  'WAIT_BODY': 1,
  'WAIT_DV': 2,
  'CONFIRM': 3,
  'ASK_SPECIALTY': 4,
  'PARSE_SPECIALTY': 5,
  'ASK_DATE': 6,
  'CHECK_AVAILABILITY': 7,
  'INFORM_AVAILABILITY': 8,
  'CONFIRM_APPOINTMENT': 9,
  'FINALIZE': 10,
  'COMPLETE': 11
};

const ALLOWED_REGRESSIONS = {
  'CONFIRM': ['WAIT_BODY'],
  'CONFIRM_APPOINTMENT': ['ASK_DATE'],
  'PARSE_SPECIALTY': ['ASK_SPECIALTY']
};

if (nextPhaseOrder < currentPhaseOrder && logicResult.nextPhase) {
  const allowed = ALLOWED_REGRESSIONS[businessState.rutPhase] || [];
  if (!allowed.includes(logicResult.nextPhase)) {
    log("warn", `⚠️ Regresión bloqueada: ${businessState.rutPhase} → ${logicResult.nextPhase}`);
    logicResult.nextPhase = businessState.rutPhase; // Bloquear
  }
}
```

---

### 4. Validación de Relevancia Semántica

**Fases que Aceptan Input:**
- `WAIT_BODY` ✅
- `CONFIRM` ✅
- `ASK_SPECIALTY` ✅
- `ASK_DATE` ✅
- `CONFIRM_APPOINTMENT` ✅

**Fases que Ignoran Input:**
- `CHECK_AVAILABILITY` ❌
- `INFORM_AVAILABILITY` ❌
- `FINALIZE` ❌

**Implementación:**
```javascript
if (isSilentPhase && transcript && transcript.trim().length > 0) {
  log("warn", `⚠️ Transcript recibido en fase silenciosa: "${transcript}"`);
  transcript = ""; // Limpiar transcript
}
```

---

## 📊 Resultado Esperado

| Métrica | Antes | Después |
|---------|-------|---------|
| Duración | ~3:15 | ~1:45 |
| "¿Sigues ahí?" | Múltiples | 0-1 |
| Repetición RUT | Sí | Nunca |
| Confusión fases | Alta | Nula |
| Experiencia adulto mayor | Regular | Muy buena |

---

## 🧪 Pruebas

### Escenario 1: Fase Silenciosa
1. Llamada entra en `CHECK_AVAILABILITY`
2. Usuario habla (audio detectado)
3. **Resultado esperado:** Transcript ignorado, solo se ejecuta webhook

### Escenario 2: "¿Sigues ahí?" en Fase Normal
1. 2 silencios consecutivos en `ASK_SPECIALTY`
2. Se reproduce "¿Sigue en línea?"
3. **Resultado esperado:** TTS estático, sin improvisación

### Escenario 3: Regresión Bloqueada
1. Dominio intenta `FINALIZE` → `CONFIRM`
2. **Resultado esperado:** Regresión bloqueada, mantiene `FINALIZE`

---

## ✅ Checklist

- [x] Fases silenciosas definidas
- [x] "¿Sigues ahí?" usa TTS estático
- [x] Omitir "¿Sigues ahí?" en fases silenciosas
- [x] Bloqueo de regresiones implementado
- [x] Validación de relevancia semántica
- [x] Transcript ignorado en fases silenciosas
- [x] Logs explícitos para debugging

---

## 🎯 Estado Final

**Todos los ajustes de orquestación conversacional implementados y compilados correctamente.**

El sistema ahora:
- ✅ Respeta fases silenciosas
- ✅ Usa TTS estático para "¿Sigues ahí?"
- ✅ Bloquea regresiones no válidas
- ✅ Valida relevancia semántica
- ✅ Mejora experiencia para adultos mayores

