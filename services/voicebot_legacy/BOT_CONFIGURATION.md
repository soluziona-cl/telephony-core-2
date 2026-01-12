# 🤖 Guía de Configuración de Bots

## 📋 Estado Actual del Sistema

### ✅ Bot Quintero (Implementado)

**Modos activos:**
- `voicebot_quintero_query` → DomainRouting activado automáticamente
- `voicebot_identity_quintero` → DomainRouting activado automáticamente  
- `voicebot_quintero` → DomainRouting activado automáticamente

**Características:**
- ✅ Webhooks n8n (toda lógica delegada)
- ✅ Barge-in deshabilitado (adultos mayores)
- ✅ State machine propia
- ✅ Aislado en dominio Identity

### 🔧 Configuración Actual

**Archivo:** `services/voicebot/inbound/voicebot-handler-inbound.js`

```javascript
// Activación automática por bot
if (mode === 'voicebot_quintero_query' || 
    mode === 'voicebot_identity_quintero' || 
    mode === 'voicebot_quintero') {
    DomainRouting = true;
}
```

## 🚀 Cómo Agregar Nuevos Bots

### Opción A: Bot Similar a Quintero (con Webhooks)

**1. Crear estructura del dominio:**
```bash
domains/{domain}/{bot_name}/
├── index.js
├── webhook-client.js
├── handlers/
│   ├── wait-body.js
│   └── confirm.js
└── ...
```

**2. Activar DomainRouting** (`voicebot-handler-inbound.js`):
```javascript
// Agregar nuevo bot a la lista
if (mode === 'voicebot_quintero_query' || 
    mode === 'voicebot_identity_quintero' || 
    mode === 'voicebot_quintero' ||
    mode === 'voicebot_tu_nuevo_bot') {  // ← Agregar aquí
    DomainRouting = true;
}
```

**3. Configurar router** (`voicebot-domain-router.js`):
```javascript
// Agregar soporte para nuevo bot
if (parts.length === 2 && parts[1] === 'tu_nuevo_bot') {
  return identityDomain; // o el dominio apropiado
}
```

**4. Configurar bot** (`voicebot-config-inbound.js`):
```javascript
"voicebot_identity_tu_nuevo_bot": {
  prompt: "tu-bot.txt",
  description: "Tu Nuevo Bot",
  requiresDb: true,
  disableBargeIn: true,
  greetingFile: "greeting_sofia_2",
  greetingText: "Mensaje inicial..."
}
```

### Opción B: Bot Simple (sin Webhooks, Engine Genérico)

**1. Solo configurar** (`voicebot-config-inbound.js`):
```javascript
"voicebot_simple": {
  prompt: "simple.txt",
  description: "Bot Simple",
  requiresDb: false,
  disableBargeIn: false,
  greetingFile: null,
  greetingText: "Hola, ¿en qué puedo ayudarle?"
}
```

**2. NO activar DomainRouting** - El engine genérico lo manejará

## 📊 Matriz de Decisión Rápida

| Característica | Quintero (Dominio) | Bot Simple (Genérico) |
|----------------|-------------------|----------------------|
| Webhooks n8n | ✅ Sí | ❌ No |
| Lógica compleja | ✅ Sí | ❌ No |
| Aislamiento | ✅ Sí | ❌ No |
| State machine propia | ✅ Sí | ❌ No |
| SQL directo | ❌ No | ✅ Sí |
| Parser local | ❌ No (fallback) | ✅ Sí |

## 🔍 Verificación Rápida

### ¿Está usando dominio?
**Buscar en logs:**
```
🔀 [VB HANDLER] DomainRouting activado específicamente
🔀 [VB HANDLER] Usando dominio
[DOMAIN] Webhook FORMAT_RUT invocado
```

### ¿Está usando engine genérico?
**Buscar en logs:**
```
DomainRouting=false
[ENGINE] Sin DomainContext - usando lógica genérica
⚙️ [RUT PARSER] reason=...
```

## 📝 Checklist Rápido

### Para bot con webhooks (como Quintero):
- [ ] Crear estructura en dominio
- [ ] Copiar `webhook-client.js` de Quintero
- [ ] Activar DomainRouting en handler
- [ ] Configurar router
- [ ] Configurar bot en config

### Para bot simple:
- [ ] Solo configurar en `voicebot-config-inbound.js`
- [ ] NO tocar DomainRouting
- [ ] Listo ✅

## 🎯 Resumen

**Quintero:** Dominio + Webhooks + Aislamiento completo
**Otros bots:** Engine genérico + SQL directo + Lógica compartida

**Para activar dominio:** Agregar mode en `voicebot-handler-inbound.js`
**Para desactivar:** No agregar mode (usa engine genérico)

