# ⚙️ Configuración del Bot Quintero

## 🎯 Estado Actual

### ✅ Características Implementadas

- **Routing por Dominio**: Activado automáticamente para `voicebot_quintero_query`
- **Webhooks n8n**: Toda la lógica de negocio delegada a webhooks
- **Barge-in deshabilitado**: Para mejorar UX en adultos mayores
- **State Machine**: WAIT_BODY → WAIT_DV → CONFIRM → COMPLETE

### 📋 Modos Soportados

| Mode | DomainRouting | Webhooks | Descripción |
|------|---------------|----------|-------------|
| `voicebot_quintero_query` | ✅ Auto-activado | ✅ Sí | Bot con webhooks (recomendado) |
| `voicebot_identity_quintero` | ✅ Auto-activado | ✅ Sí | Bot con webhooks (formato estándar) |
| `voicebot_quintero` | ✅ Auto-activado | ✅ Sí | Bot legacy con webhooks |

## 🔗 Webhooks Configurados

### Base URL
```
https://omnicanal.evoluziona.cl/webhook/c35e936f-0b53-4bff-ab67-87c69da641ee
```

### Eventos Implementados

1. **FORMAT_RUT**: Formatea RUT desde transcripción
2. **VALIDATE_PATIENT**: Valida paciente por RUT
3. **GET_NEXT_AVAILABILITY**: Busca próxima hora médica
4. **CONFIRM_AVAILABILITY**: Confirma hora reservada
5. **RELEASE_AVAILABILITY**: Libera hora reservada

## 📁 Estructura del Dominio

```
domains/identity/quintero/
├── index.js              # Entry point del bot
├── state-machine.js      # Máquina de estados
├── config.js             # Configuración (retries, timeouts)
├── webhook-client.js     # Cliente HTTP para n8n
├── handlers/
│   ├── wait-body.js      # Handler WAIT_BODY (FORMAT_RUT)
│   ├── wait-dv.js        # Handler WAIT_DV
│   └── confirm.js        # Handler CONFIRM (VALIDATE_PATIENT)
├── rut/
│   ├── rut-parser.js     # Parser local (fallback)
│   ├── rut-validator.js  # Validador local (fallback)
│   └── rut-normalizer.js # Normalizador
├── tts/
│   └── messages.js        # Mensajes TTS
└── prompts/
    └── quintero-confirmacion.txt
```

## 🚀 Cómo Funciona

### Flujo de Ejecución

```
1. Asterisk → handleVoiceBot (mode=voicebot_quintero_query)
   ↓
2. Handler detecta mode → DomainRouting = true
   ↓
3. Router resuelve → identityDomain
   ↓
4. identityDomain → quinteroBot
   ↓
5. quinteroBot → runState (state machine)
   ↓
6. Handler (wait-body/confirm) → webhook-client.js
   ↓
7. webhook-client.js → n8n webhook
   ↓
8. Respuesta → Handler → State Machine → Engine
```

### Delegación vs Lógica Local

| Componente | Quintero (con dominio) | Engine Genérico |
|------------|----------------------|-----------------|
| Formateo RUT | ✅ Webhook FORMAT_RUT | ❌ Parser local |
| Validación paciente | ✅ Webhook VALIDATE_PATIENT | ❌ SQL directo |
| Búsqueda horas | ✅ Webhook GET_NEXT_AVAILABILITY | ❌ SQL directo |
| Confirmación hora | ✅ Webhook CONFIRM_AVAILABILITY | ❌ SQL directo |

## 🔧 Configuración para Futuros Bots

### Caso 1: Bot Similar a Quintero (con webhooks)

**Pasos:**

1. **Crear estructura en dominio apropiado:**
   ```bash
   domains/{domain}/{bot_name}/
   ├── index.js
   ├── webhook-client.js  # Copiar de quintero y adaptar
   ├── handlers/
   └── ...
   ```

2. **Actualizar router** (`voicebot-domain-router.js`):
   ```javascript
   // Agregar soporte para nuevo bot
   if (parts.length === 2 && parts[1] === 'nuevo_bot') {
     return identityDomain; // o el dominio apropiado
   }
   ```

3. **Activar DomainRouting en handler** (`voicebot-handler-inbound.js`):
   ```javascript
   if (mode === 'voicebot_nuevo_bot' || mode === 'voicebot_identity_nuevo_bot') {
     DomainRouting = true;
   }
   ```

4. **Configurar bot** (`voicebot-config-inbound.js`):
   ```javascript
   "voicebot_identity_nuevo_bot": {
     prompt: "nuevo-bot.txt",
     description: "Nuevo Bot con webhooks",
     requiresDb: true,
     disableBargeIn: true, // si aplica
     greetingFile: "greeting_sofia_2",
     greetingText: "Mensaje inicial..."
   }
   ```

### Caso 2: Bot Diferente (sin webhooks, lógica local)

**Pasos:**

1. **NO crear dominio** - usar engine genérico
2. **NO activar DomainRouting** - dejar `false`
3. **Configurar bot** (`voicebot-config-inbound.js`):
   ```javascript
   "voicebot_otro_bot": {
     prompt: "otro-bot.txt",
     description: "Bot sin webhooks",
     requiresDb: false,
     disableBargeIn: false,
     greetingFile: null,
     greetingText: "Mensaje inicial..."
   }
   ```

4. **El engine genérico usará:**
   - Parser local de RUT
   - SQL directo para validación
   - Lógica interna

## 📊 Matriz de Decisión

| ¿Necesitas webhooks? | ¿Lógica compleja? | ¿Aislamiento? | Solución |
|---------------------|-------------------|---------------|----------|
| ✅ Sí | ✅ Sí | ✅ Sí | **Dominio con webhooks** (como Quintero) |
| ❌ No | ✅ Sí | ✅ Sí | **Dominio sin webhooks** |
| ❌ No | ❌ No | ❌ No | **Engine genérico** |

## 🔍 Logs de Verificación

### Cuando funciona con dominio:

```
🔀 [VB HANDLER] DomainRouting activado específicamente para mode=voicebot_quintero_query
🔀 [VB HANDLER] Usando dominio para mode=voicebot_quintero_query, bot=quintero
🔀 [ENGINE] DomainContext recibido: bot=quintero, mode=voicebot_quintero_query
[DOMAIN] Invocando dominio para fase: WAIT_BODY
[DOMAIN] Webhook FORMAT_RUT invocado
📤 [WEBHOOK] FORMAT_RUT: "..."
✅ [WEBHOOK] RUT formateado: 14348258-8
```

### Cuando NO funciona con dominio:

```
DomainRouting=false
[ENGINE] Sin DomainContext - usando lógica genérica
⚙️ [RUT PARSER] reason=missing_dv body=1348258
```

## 🛠️ Troubleshooting

### Problema: No se activa el dominio

**Causa:** Mode no está en la lista de activación
**Solución:** Agregar mode en `voicebot-handler-inbound.js`:
```javascript
if (mode === 'voicebot_quintero_query' || mode === 'voicebot_tu_nuevo_bot') {
  DomainRouting = true;
}
```

### Problema: Error "Cannot find module logger.js"

**Causa:** Path incorrecto
**Solución:** Verificar niveles de directorio:
- Desde `handlers/`: `../../../../../../lib/logger.js` (7 niveles)
- Desde `quintero/`: `../../../../../lib/logger.js` (6 niveles)

### Problema: Webhooks no se invocan

**Causa:** DomainRouting activado pero dominio no se resuelve
**Solución:** Verificar router y logs:
```javascript
// Verificar en logs:
🔀 [ROUTER] Resolviendo: mode="..." → domain="...", bot="..."
```

## 📝 Checklist para Nuevo Bot Similar a Quintero

- [ ] Crear estructura en dominio apropiado
- [ ] Copiar y adaptar `webhook-client.js`
- [ ] Crear handlers (wait-body, confirm, etc.)
- [ ] Actualizar router para reconocer nuevo mode
- [ ] Activar DomainRouting en handler
- [ ] Configurar bot en `voicebot-config-inbound.js`
- [ ] Agregar mensajes TTS
- [ ] Probar con logs de verificación

## 🎯 Resumen Ejecutivo

**Quintero actual:**
- ✅ DomainRouting activado automáticamente
- ✅ Webhooks funcionando
- ✅ Aislado en dominio Identity
- ✅ Logs explícitos para debugging

**Futuros bots similares:**
- Copiar estructura de Quintero
- Adaptar webhook-client.js
- Activar DomainRouting por mode
- Configurar en router

**Futuros bots diferentes:**
- Usar engine genérico
- NO activar DomainRouting
- Configurar en voicebot-config-inbound.js

