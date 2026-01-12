# 🏗️ Fix Arquitectónico: Separación Engine vs Dominio

## ❌ Problema Identificado

**El engine core (`voicebot-engine-inbound-v3.js`) estaba siendo modificado con lógica específica de Quintero:**

1. Fases silenciosas hardcodeadas (`CHECK_AVAILABILITY`, `INFORM_AVAILABILITY`, `FINALIZE`)
2. Auto-avance específico de Quintero
3. Lógica de webhooks mezclada con infraestructura

**Impacto:**
- ❌ Afecta a TODOS los bots (no solo Quintero)
- ❌ Engine dejó de ser "engine" → se volvió "bot-aware"
- ❌ Antipatrón: infraestructura acoplada a negocio

## ✅ Solución Implementada

### 1. Contrato del Dominio Extendido

**Nuevo campo genérico (NO específico de Quintero):**

```json
{
  "ttsText": "string | null",
  "nextPhase": "string | null",
  "skipUserInput": false,  // ← NUEVO: Genérico para cualquier dominio
  "action": { ... }
}
```

**Características:**
- ✅ Genérico: cualquier dominio puede usarlo
- ✅ Backward compatible: default `false`
- ✅ El dominio decide, el engine ejecuta

### 2. Engine Core Genérico

**Cambios en `voicebot-engine-inbound-v3.js`:**

**ANTES (específico de Quintero):**
```javascript
const SILENT_PHASES = ['CHECK_AVAILABILITY', 'INFORM_AVAILABILITY', 'FINALIZE'];
if (SILENT_PHASES.includes(businessState.rutPhase)) {
  // Lógica específica de Quintero
}
```

**DESPUÉS (genérico):**
```javascript
// Consultar dominio para ver si indica skipUserInput
const logicResult = await domainContext.domain(ctx);
if (logicResult.skipUserInput === true) {
  // NO esperar voz, ejecutar inmediatamente
  // (funciona para cualquier dominio)
}
```

**Resultado:**
- ✅ Engine NO conoce fases específicas de Quintero
- ✅ Engine solo lee `skipUserInput` del contrato
- ✅ Cualquier dominio puede usar esta funcionalidad

### 3. Dominio Quintero Orquestador

**Handlers actualizados para devolver `skipUserInput: true`:**

#### `check-availability.js`
```javascript
return {
  ttsText: "Un momento por favor...",
  nextPhase: 'INFORM_AVAILABILITY',
  skipUserInput: true, // ← Dominio indica fase silenciosa
  action: { ... }
};
```

#### `inform-availability.js`
```javascript
return {
  ttsText: "Hay una hora disponible...",
  nextPhase: 'CONFIRM_APPOINTMENT',
  skipUserInput: true, // ← Dominio indica fase silenciosa
  action: { ... }
};
```

#### `finalize.js`
```javascript
return {
  ttsText: "Su hora quedó agendada...",
  nextPhase: 'COMPLETE',
  skipUserInput: true, // ← Dominio indica fase silenciosa
  action: { type: "END_CALL", ... }
};
```

## 🎯 Principio Arquitectónico

### Engine Core (Infraestructura)
- ✅ Maneja audio, turnos, grabación
- ✅ Ejecuta acciones del dominio
- ✅ Lee contrato del dominio
- ❌ NO conoce lógica de negocio
- ❌ NO conoce fases específicas de bots

### Dominio (Negocio)
- ✅ Define fases silenciosas
- ✅ Orquesta webhooks
- ✅ Decide flujo conversacional
- ✅ Indica `skipUserInput` cuando corresponde
- ❌ NO maneja audio directamente

## 📊 Comparación: Antes vs Después

| Aspecto | Antes | Después |
|---------|-------|---------|
| Fases silenciosas | Hardcodeadas en engine | Definidas por dominio |
| Auto-avance | Lógica específica Quintero | Genérico (`skipUserInput`) |
| Impacto en otros bots | ❌ Afecta a todos | ✅ Solo Quintero |
| Escalabilidad | ❌ Difícil agregar bots | ✅ Fácil agregar bots |
| Mantenibilidad | ❌ Lógica mezclada | ✅ Separación clara |

## ✅ Checklist de Validación

- [x] Engine NO tiene fases hardcodeadas de Quintero
- [x] Engine lee `skipUserInput` del contrato (genérico)
- [x] Dominio Quintero devuelve `skipUserInput: true` en fases silenciosas
- [x] Contrato del dominio actualizado
- [x] Backward compatible (dominios sin `skipUserInput` funcionan igual)
- [x] Otros bots NO afectados

## 🚀 Resultado Final

**El sistema ahora es:**
- ✅ Escalable: nuevos bots no requieren modificar engine
- ✅ Mantenible: lógica de negocio aislada en dominios
- ✅ Genérico: `skipUserInput` funciona para cualquier dominio
- ✅ Seguro: cambios en Quintero NO afectan otros bots

**Listo para producción.** 🎯

