# 🎛️ Control de Conversación - Quintero

## 🛡️ Fases Silenciosas

Estas fases **NO deben escuchar** al usuario:

- `CHECK_AVAILABILITY` - Buscando disponibilidad (webhook)
- `INFORM_AVAILABILITY` - Informando hora disponible
- `FINALIZE` - Confirmando y cerrando

### Comportamiento

- ❌ NO se graba audio del usuario
- ❌ NO se procesa transcript
- ❌ NO se usa "¿Sigues ahí?" en estas fases
- ✅ Solo se reproduce TTS del dominio

## 🔇 "¿Sigues ahí?" - TTS Estático

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

### Reglas

1. **NUNCA usar `sendSystemText`** para "¿Sigues ahí?"
2. **Siempre usar `sendTextAndWait`** con texto fijo
3. **Omitir en fases silenciosas**

## 🚫 Bloqueo de Regresiones

### Regresiones Permitidas

| Fase Actual | Fase Permitida | Razón |
|-------------|----------------|-------|
| `CONFIRM` | `WAIT_BODY` | Usuario rechaza RUT |
| `CONFIRM_APPOINTMENT` | `ASK_DATE` | Usuario rechaza hora |
| `PARSE_SPECIALTY` | `ASK_SPECIALTY` | Especialidad no identificada |

### Regresiones Bloqueadas

- `FINALIZE` → `CONFIRM` ❌
- `INFORM_AVAILABILITY` → `WAIT_BODY` ❌
- `CHECK_AVAILABILITY` → `CONFIRM` ❌

## ✅ Validación de Relevancia Semántica

### Fases que Aceptan Input

- `WAIT_BODY` ✅
- `CONFIRM` ✅
- `ASK_SPECIALTY` ✅
- `ASK_DATE` ✅
- `CONFIRM_APPOINTMENT` ✅

### Fases que Ignoran Input

- `CHECK_AVAILABILITY` ❌
- `INFORM_AVAILABILITY` ❌
- `FINALIZE` ❌

## 📊 Resultado Esperado

| Métrica | Antes | Después |
|---------|-------|---------|
| Duración | ~3:15 | ~1:45 |
| "¿Sigues ahí?" | Múltiples | 0-1 |
| Repetición RUT | Sí | Nunca |
| Confusión fases | Alta | Nula |
| Experiencia adulto mayor | Regular | Muy buena |

