# 🏗️ Separación de Responsabilidades: Engine vs Dominio

## 🎯 Principio Fundamental

**El engine es infraestructura. El dominio es negocio.**

## 📦 Responsabilidades del Engine Core

### ✅ SÍ debe hacer:
- Manejar audio (grabación, reproducción)
- Gestionar turnos conversacionales
- Detectar voz del usuario
- Ejecutar acciones del dominio (`SET_STATE`, `END_CALL`, etc.)
- Leer contrato del dominio (`ttsText`, `nextPhase`, `skipUserInput`, `action`)
- Manejar barge-in
- Gestionar transcripciones (ASR)
- Generar TTS desde texto

### ❌ NO debe hacer:
- Conocer fases específicas de bots (`CHECK_AVAILABILITY`, etc.)
- Tener lógica de negocio hardcodeada
- Decidir qué webhook llamar
- Validar RUTs
- Consultar bases de datos
- Interpretar especialidades médicas

## 📦 Responsabilidades del Dominio

### ✅ SÍ debe hacer:
- Definir fases conversacionales
- Orquestar webhooks
- Validar datos de negocio
- Decidir flujo conversacional
- Indicar `skipUserInput` para fases silenciosas
- Devolver acciones al engine (`SET_STATE`, `END_CALL`, etc.)

### ❌ NO debe hacer:
- Manejar audio directamente
- Gestionar turnos técnicos
- Controlar barge-in directamente
- Manejar transcripciones directamente

## 🔄 Flujo de Comunicación

```
┌─────────────┐
│   Engine    │  ← Infraestructura pura
└──────┬──────┘
       │
       │ 1. Invoca dominio con ctx
       │
       ▼
┌─────────────┐
│   Dominio   │  ← Negocio específico
└──────┬──────┘
       │
       │ 2. Devuelve contrato
       │    {
       │      ttsText: "...",
       │      nextPhase: "...",
       │      skipUserInput: true/false,
       │      action: { ... }
       │    }
       │
       ▼
┌─────────────┐
│   Engine    │  ← Ejecuta contrato
└─────────────┘
```

## ✅ Ejemplo Correcto: Quintero

### Dominio Quintero (`check-availability.js`)
```javascript
// ✅ CORRECTO: Dominio decide
return {
  ttsText: "Un momento por favor...",
  nextPhase: 'INFORM_AVAILABILITY',
  skipUserInput: true, // ← Dominio indica fase silenciosa
  action: {
    type: "SET_STATE",
    payload: { updates: { ... } }
  }
};
```

### Engine Core
```javascript
// ✅ CORRECTO: Engine solo lee contrato
if (logicResult.skipUserInput === true) {
  // NO esperar voz
  // Ejecutar inmediatamente
}
```

## ❌ Ejemplo Incorrecto: Hardcode en Engine

```javascript
// ❌ INCORRECTO: Engine conoce fases específicas
const SILENT_PHASES = ['CHECK_AVAILABILITY', 'INFORM_AVAILABILITY'];
if (SILENT_PHASES.includes(businessState.rutPhase)) {
  // Lógica específica de Quintero
}
```

## 🎯 Regla de Oro

**Si una funcionalidad es específica de un bot, debe estar en el dominio, NO en el engine.**

## 📊 Checklist de Validación

Antes de modificar el engine, pregúntate:

- [ ] ¿Esta funcionalidad es específica de un bot?
  - ✅ Sí → Va al dominio
  - ❌ No → Puede ir al engine (si es infraestructura)

- [ ] ¿Esta funcionalidad requiere conocimiento de negocio?
  - ✅ Sí → Va al dominio
  - ❌ No → Puede ir al engine (si es infraestructura)

- [ ] ¿Otros bots necesitarán esta funcionalidad?
  - ✅ Sí → Va al engine (genérico)
  - ❌ No → Va al dominio

## 🚀 Resultado

**Con esta separación:**
- ✅ Cambios en Quintero NO afectan otros bots
- ✅ Engine permanece estable y genérico
- ✅ Nuevos bots son fáciles de agregar
- ✅ Mantenibilidad mejorada

