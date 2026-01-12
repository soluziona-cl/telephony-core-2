# 📜 Contrato Oficial: Dominio → Engine

## 🎯 Principio Base

**El dominio decide. El engine ejecuta. La telefonía transporta.**

## 📦 Estructura del Contrato

### Formato Base (Backward Compatible)

```json
{
  "ttsText": "string | null",
  "nextPhase": "string | null",
  "shouldHangup": false,
  "skipUserInput": false,
  "action": null | {
    "type": "USE_ENGINE | CALL_WEBHOOK | SET_STATE | END_CALL",
    "payload": {}
  }
}
```

### Campos Obligatorios

| Campo | Tipo | Descripción | Requerido |
|-------|------|-------------|-----------|
| `ttsText` | `string \| null` | Texto a reproducir (TTS) | ✅ Sí |
| `nextPhase` | `string \| null` | Próxima fase del FSM | ✅ Sí |
| `shouldHangup` | `boolean` | Finalizar llamada | ❌ No (default: false) |
| `skipUserInput` | `boolean` | NO esperar voz del usuario (fase silenciosa) | ❌ No (default: false) |
| `action` | `object \| null` | Acción a ejecutar | ❌ No (opcional) |

## 🔧 Tipos de Acción

### 1. USE_ENGINE

**Propósito:** Cambiar el motor lógico que procesa la llamada.

**Estructura:**
```json
{
  "type": "USE_ENGINE",
  "payload": {
    "engine": "WITH_QUERY | V3 | CUSTOM",
    "context": {
      "rut": "string",
      "bot": "string",
      "params": {}
    }
  }
}
```

**Ejemplo (Quintero):**
```json
{
  "ttsText": null,
  "nextPhase": "WAIT_BODY",
  "action": {
    "type": "USE_ENGINE",
    "payload": {
      "engine": "WITH_QUERY",
      "context": {
        "rut": "13482588",
        "bot": "quintero"
      }
    }
  }
}
```

### 2. CALL_WEBHOOK

**Propósito:** Ejecutar lógica de negocio vía webhook n8n.

**Estructura:**
```json
{
  "type": "CALL_WEBHOOK",
  "payload": {
    "name": "FORMAT_RUT | VALIDATE_PATIENT | GET_NEXT_AVAILABILITY | CONFIRM_AVAILABILITY | RELEASE_AVAILABILITY",
    "params": {},
    "onSuccess": {
      "nextPhase": "string",
      "ttsText": "string"
    },
    "onError": {
      "nextPhase": "string",
      "ttsText": "string"
    }
  }
}
```

**Ejemplo:**
```json
{
  "ttsText": "Un momento por favor.",
  "nextPhase": "WAIT_BODY",
  "action": {
    "type": "CALL_WEBHOOK",
    "payload": {
      "name": "VALIDATE_PATIENT",
      "params": {
        "rut": "13482588-8",
        "sessionId": "1767645981.386"
      },
      "onSuccess": {
        "nextPhase": "COMPLETE",
        "ttsText": "Paciente validado correctamente."
      },
      "onError": {
        "nextPhase": "FAILED",
        "ttsText": "No fue posible validar sus datos."
      }
    }
  }
}
```

### 3. SET_STATE

**Propósito:** Mutar el estado del FSM sin cambiar de fase.

**Estructura:**
```json
{
  "type": "SET_STATE",
  "payload": {
    "updates": {
      "rutBody": "string",
      "rutDv": "string",
      "rutFormatted": "string"
    }
  }
}
```

### 4. END_CALL

**Propósito:** Finalizar la llamada de forma controlada.

**Estructura:**
```json
{
  "type": "END_CALL",
  "payload": {
    "reason": "COMPLETE | FAILED | USER_HANGUP",
    "ttsText": "string"
  }
}
```

## ✅ Reglas de Validación

1. **Si `action` es `null`:** El engine usa lógica genérica (backward compatible)
2. **Si `action.type` existe:** El engine DEBE ejecutar la acción
3. **Si `nextPhase` es `null`:** Mantener fase actual
4. **Si `ttsText` es `null`:** No reproducir audio

## 🔄 Flujo de Ejecución

```
Dominio → Devuelve contrato
  ↓
Engine → Lee action.type
  ↓
Si action.type === "CALL_WEBHOOK"
  → Ejecuta webhook
  → Aplica onSuccess/onError
  → Actualiza estado
  ↓
Si action.type === "USE_ENGINE"
  → Cambia engine
  → Pasa contexto
  ↓
Si action === null
  → Usa lógica genérica (backward compatible)
```

## 📋 Ejemplos Completos

### Ejemplo 1: Solo Conversación (Sin Acción)

```json
{
  "ttsText": "Por favor, indíqueme su RUT completo.",
  "nextPhase": "WAIT_BODY",
  "shouldHangup": false,
  "action": null
}
```

### Ejemplo 2: Con Webhook

```json
{
  "ttsText": "Validando sus datos...",
  "nextPhase": "WAIT_BODY",
  "action": {
    "type": "CALL_WEBHOOK",
    "payload": {
      "name": "FORMAT_RUT",
      "params": {
        "rutRaw": "millones trescientos...",
        "sessionId": "1767645981.386"
      },
      "onSuccess": {
        "nextPhase": "CONFIRM",
        "ttsText": "Tengo registrado el RUT terminado en..."
      }
    }
  }
}
```

### Ejemplo 3: Cambiar Engine

```json
{
  "ttsText": null,
  "nextPhase": "WAIT_BODY",
  "action": {
    "type": "USE_ENGINE",
    "payload": {
      "engine": "WITH_QUERY",
      "context": {
        "rut": "13482588-8",
        "bot": "quintero"
      }
    }
  }
}
```

## 🎯 Backward Compatibility

**Dominios que NO usan `action`:**
- Devuelven solo `ttsText` y `nextPhase`
- Engine usa lógica genérica
- ✅ Funciona igual que antes

**Dominios que SÍ usan `action`:**
- Devuelven contrato completo
- Engine ejecuta acción
- ✅ Nuevo comportamiento

