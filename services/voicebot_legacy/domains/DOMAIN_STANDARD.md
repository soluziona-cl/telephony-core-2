# 📜 Estándar OmniFlows: Dominios Orquestadores

## 🎯 Principio Fundamental

**El dominio decide. El engine ejecuta. La telefonía transporta.**

## ❌ Lo que un Dominio NO debe hacer

- ❌ Ejecutar lógica de negocio directamente
- ❌ Acceder a bases de datos
- ❌ Controlar audio/STT/TTS
- ❌ Gestionar sesiones de telefonía
- ❌ Hacer llamadas HTTP directamente (excepto webhooks específicos del dominio)

## ✅ Lo que un Dominio SÍ debe hacer

- ✅ Decidir acciones
- ✅ Controlar fases (FSM)
- ✅ Orquestar engines
- ✅ Devolver contratos estructurados
- ✅ Validar entrada del usuario
- ✅ Clasificar intenciones

## 📦 Contrato Obligatorio

Todo dominio DEBE devolver:

```javascript
{
  ttsText: string | null,
  nextPhase: string | null,
  shouldHangup: boolean,
  action: null | {
    type: "USE_ENGINE | CALL_WEBHOOK | SET_STATE | END_CALL",
    payload: {}
  }
}
```

Ver `DOMAIN_CONTRACT.md` para detalles completos.

## 🏗️ Estructura Estándar de Dominio

```
domains/{domain}/{bot}/
├── index.js              # Entry point (orquestador)
├── state-machine.js      # FSM del dominio
├── handlers/             # Handlers por fase
│   ├── wait-body.js
│   ├── confirm.js
│   └── ...
├── actions.js            # Definiciones de acciones
├── rules.js               # Reglas de negocio
├── webhook-client.js      # Cliente webhook (si aplica)
└── config.js              # Configuración del dominio
```

## 🧩 Plantilla Base de Handler

```javascript
/**
 * Handler para fase {PHASE}
 * @param {object} ctx - Contexto (transcript, sessionId, ani, dnis, state)
 * @param {object} state - Estado del dominio
 * @returns {Promise<object>} - Contrato dominio → engine
 */
export default async function handler(ctx, state) {
  const { transcript, sessionId } = ctx;
  
  // 1. Validar entrada
  if (!transcript) {
    return {
      ttsText: "No entendí, ¿puede repetir?",
      nextPhase: ctx.state.rutPhase, // Mantener fase
      shouldHangup: false,
      action: null
    };
  }
  
  // 2. Llamar webhook si es necesario
  const webhookResult = await webhookClient.someAction(params);
  
  // 3. Decidir acción
  if (webhookResult.ok) {
    return {
      ttsText: "Mensaje de éxito",
      nextPhase: "NEXT_PHASE",
      shouldHangup: false,
      action: {
        type: "USE_ENGINE",
        payload: {
          engine: "WITH_QUERY",
          context: { /* datos */ }
        }
      }
    };
  }
  
  // 4. Fallback (solo conversación)
  return {
    ttsText: "Mensaje de error",
    nextPhase: "CURRENT_PHASE",
    shouldHangup: false,
    action: null
  };
}
```

## 🎯 Reglas de Oro

### 1. Siempre devolver contrato estructurado

❌ **MAL:**
```javascript
return "Texto a decir";
```

✅ **BIEN:**
```javascript
return {
  ttsText: "Texto a decir",
  nextPhase: "WAIT_BODY",
  shouldHangup: false,
  action: null
};
```

### 2. Nunca devolver solo texto

❌ **MAL:**
```javascript
return { ttsText: "Hola" };
```

✅ **BIEN:**
```javascript
return {
  ttsText: "Hola",
  nextPhase: "WAIT_BODY",
  shouldHangup: false,
  action: null
};
```

### 3. Si hay decisión → usar action

❌ **MAL:**
```javascript
// Llamar webhook y luego devolver texto
await webhook();
return { ttsText: "OK" };
```

✅ **BIEN:**
```javascript
// Devolver acción estructurada
return {
  ttsText: "Validando...",
  nextPhase: "WAIT_BODY",
  action: {
    type: "CALL_WEBHOOK",
    payload: {
      name: "VALIDATE_PATIENT",
      params: { rut: "..." },
      onSuccess: { nextPhase: "COMPLETE" }
    }
  }
};
```

### 4. No repetir fases

❌ **MAL:**
```javascript
// Si ya estamos en WAIT_BODY, no devolver WAIT_BODY de nuevo
return { nextPhase: "WAIT_BODY" }; // Loop infinito
```

✅ **BIEN:**
```javascript
// Avanzar o mantener con acción
return {
  nextPhase: "CONFIRM", // Avanzar
  action: { type: "SET_STATE", ... }
};
```

### 5. FSM estricta

Solo transiciones válidas:
- `WAIT_BODY` → `WAIT_DV` | `CONFIRM`
- `WAIT_DV` → `CONFIRM`
- `CONFIRM` → `COMPLETE` | `WAIT_BODY`
- `COMPLETE` → `END`

## 📋 Checklist para Nuevo Dominio

- [ ] Estructura de carpetas estándar
- [ ] Handlers devuelven contrato completo
- [ ] State machine con transiciones válidas
- [ ] Webhook client (si aplica)
- [ ] Configuración aislada
- [ ] Logs explícitos `[DOMAIN]`
- [ ] Documentación en README.md

## 🔍 Ejemplos de Dominios

### Dominio Simple (solo conversación)

```javascript
export default async function simpleDomain(ctx) {
  return {
    ttsText: "Hola, ¿en qué puedo ayudarle?",
    nextPhase: "WAIT_INTENT",
    shouldHangup: false,
    action: null // Sin acción, solo conversación
  };
}
```

### Dominio Orquestador (como Quintero)

```javascript
export default async function quinteroDomain(ctx) {
  const { rutPhase } = ctx.state;
  
  if (rutPhase === 'WAIT_BODY') {
    const result = await waitBodyHandler(ctx, ctx.state);
    // result ya tiene action estructurada
    return result;
  }
  
  // ...
}
```

## 🎯 Convención de Nombres

- **Handlers:** `wait-body.js`, `confirm.js` (kebab-case)
- **Actions:** `USE_ENGINE`, `CALL_WEBHOOK` (UPPER_SNAKE_CASE)
- **Phases:** `WAIT_BODY`, `CONFIRM` (UPPER_SNAKE_CASE)
- **Funciones:** `waitBody`, `confirm` (camelCase)

## 📚 Referencias

- **Contrato completo:** `DOMAIN_CONTRACT.md`
- **Ejemplo real:** `domains/identity/quintero/`
- **Guía migración:** `MIGRATION.md`

