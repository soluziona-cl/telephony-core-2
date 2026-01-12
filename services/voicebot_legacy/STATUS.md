# 📊 Estado de Configuración - VoiceBot System

**Última actualización:** 2026-01-05

## 🎯 Estado Actual

### ✅ Bot Quintero

**Modos activos con DomainRouting:**
- ✅ `voicebot_quintero_query` → **ACTIVO** (webhooks)
- ✅ `voicebot_identity_quintero` → **ACTIVO** (webhooks)
- ✅ `voicebot_quintero` → **ACTIVO** (webhooks)

**Configuración:**
- **DomainRouting:** Activado automáticamente por bot
- **Webhooks:** ✅ Implementados (FORMAT_RUT, VALIDATE_PATIENT, GET_NEXT_AVAILABILITY, CONFIRM_AVAILABILITY, RELEASE_AVAILABILITY)
- **Barge-in:** Deshabilitado (adultos mayores)
- **Lógica:** 100% delegada a n8n webhooks
- **Aislamiento:** Dominio Identity/Quintero

**Ubicación:**
```
domains/identity/quintero/
├── webhook-client.js      ← Cliente n8n
├── handlers/
│   ├── wait-body.js       ← FORMAT_RUT
│   └── confirm.js          ← VALIDATE_PATIENT
└── ...
```

### 🔧 Engine Genérico

**Uso:** Para bots que NO tienen DomainRouting activado

**Características:**
- Parser RUT local
- SQL directo (getPatientByRut, getAndHoldNextSlot)
- Lógica compartida

**Ubicación:**
```
inbound/voicebot-engine-inbound-v3.js
```

## 🚦 Activación de DomainRouting

### Actual (por bot específico)

**Archivo:** `inbound/voicebot-handler-inbound.js`

```javascript
// Línea 43-44
if (mode === 'voicebot_quintero_query' || 
    mode === 'voicebot_identity_quintero' || 
    mode === 'voicebot_quintero') {
    DomainRouting = true;
}
```

### Para agregar nuevo bot con webhooks

**Agregar mode a la lista:**
```javascript
if (mode === 'voicebot_quintero_query' || 
    mode === 'voicebot_identity_quintero' || 
    mode === 'voicebot_quintero' ||
    mode === 'voicebot_tu_nuevo_bot') {  // ← Agregar aquí
    DomainRouting = true;
}
```

## 📋 Matriz de Configuración

| Bot | Mode | DomainRouting | Webhooks | Lógica |
|-----|------|---------------|----------|--------|
| Quintero | `voicebot_quintero_query` | ✅ Auto | ✅ Sí | n8n |
| Quintero | `voicebot_identity_quintero` | ✅ Auto | ✅ Sí | n8n |
| Quintero | `voicebot_quintero` | ✅ Auto | ✅ Sí | n8n |
| Otros | `voicebot_*` | ❌ No | ❌ No | Engine genérico |

## 🔍 Verificación Rápida

### Logs cuando funciona con dominio:
```
🔀 [VB HANDLER] DomainRouting activado específicamente
🔀 [VB HANDLER] Usando dominio
[DOMAIN] Webhook FORMAT_RUT invocado
📤 [WEBHOOK] FORMAT_RUT: "..."
```

### Logs cuando NO funciona con dominio:
```
DomainRouting=false
[ENGINE] Sin DomainContext
⚙️ [RUT PARSER] reason=...
```

## 📚 Documentación

- **Quintero específico:** `domains/identity/quintero/CONFIG.md`
- **Guía general:** `BOT_CONFIGURATION.md`
- **Migración:** `domains/MIGRATION.md`

## 🎯 Resumen Ejecutivo

**Quintero:** Dominio activo + Webhooks funcionando + Aislado
**Otros bots:** Engine genérico + SQL directo + Lógica compartida

**Para activar dominio en nuevo bot:** Agregar mode en línea 43 de `voicebot-handler-inbound.js`

