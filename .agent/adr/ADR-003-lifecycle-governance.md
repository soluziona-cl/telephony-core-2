# ADR-003: Lifecycle Governance Engine-wide

**Fecha:** 2026-01-19  
**Estado:** Aceptado  
**Contexto:** VoiceBot Engine V3

---

## 🎯 Problema

El engine no tenía reglas explícitas sobre qué acciones están permitidas/denegadas en cada fase del bot, causando:

- Bridges destruidos prematuramente
- Snoops eliminados durante LISTEN_RUT
- STT inicializado en fases incorrectas
- Condiciones de carrera entre verificación y ejecución
- Bugs transversales difíciles de rastrear

---

## 🧠 Decisión

Implementar un **Lifecycle Contract central** que gobierne todas las acciones del engine basándose en la fase actual, sin crear engines por bot.

### Principio Fundamental

**El dominio decide QUÉ, el lifecycle decide CÓMO y CUÁNDO**

---

## 📋 Arquitectura

### 1️⃣ Lifecycle Contract (Único, Global)

**Archivo:** `services/core/engine/lifecycle-contract.js`

Define reglas operativas por fase:

```javascript
LIFECYCLE_CONTRACT = {
  START_GREETING: {
    allow: ['PLAYBACK', 'CREATE_BRIDGE'],
    deny:  ['STT', 'HANGUP', 'DESTROY_BRIDGE', 'DESTROY_SNOOP'],
    requires: ['BRIDGE'],
    teardownAllowed: false
  },
  
  LISTEN_RUT: {
    allow: ['STT', 'CREATE_SNOOP'],
    deny:  ['PLAYBACK', 'DESTROY_SNOOP', 'DESTROY_BRIDGE', 'HANGUP'],
    requires: ['BRIDGE', 'SNOOP'],
    teardownAllowed: false
  },
  
  // ... más fases
}
```

### 2️⃣ Validaciones en Engine

**Archivo:** `services/core/engine/voice-engine.js`

Validaciones aplicadas en puntos críticos:

- **Antes de destruir bridge:** `isTeardownAllowed(phase)`
- **Antes de inicializar STT:** `isActionAllowed(phase, 'STT')`
- **Antes de crear Snoop:** `isActionAllowed(phase, 'CREATE_SNOOP')`
- **Antes de playback:** `isActionAllowed(phase, 'PLAYBACK')`

### 3️⃣ Validaciones en ARI Listener

**Archivo:** `services/core/ari/ari-listener.js`

Protección de Snoop durante cleanup:

- **Antes de destruir Snoop:** `isActionAllowed(phase, 'DESTROY_SNOOP')`
- **Verificación de teardown:** `isTeardownAllowed(phase)`

---

## 🔑 Reglas Clave

### ✅ Mismo ID de Fase

Las fases del dominio y del lifecycle contract **deben usar el mismo identificador**:

```
DOMAIN: phase="LISTEN_RUT"
LIFECYCLE: LISTEN_RUT: { ... }
```

Esto garantiza:
- Una sola verdad
- Trazabilidad perfecta
- Logs coherentes

### ✅ Un Solo Engine

- **NO** se crean engines por bot
- **SÍ** se aplican contratos dinámicamente
- El engine es agnóstico del dominio

### ✅ Gobernanza Fuerte

Si una acción no está permitida:

```
🔒 [LIFECYCLE] STT bloqueado en fase START_GREETING
```

El engine **NO ejecuta** la acción, ARI nunca recibe la orden.

---

## 🧩 Extensibilidad

### Agregar Nuevas Fases

Solo agregar al contrato:

```javascript
ASK_SPECIALTY: {
  allow: ['PLAYBACK', 'STT', 'CREATE_SNOOP'],
  deny: ['DESTROY_SNOOP', 'DESTROY_BRIDGE'],
  requires: ['BRIDGE', 'SNOOP'],
  teardownAllowed: false
}
```

**NO requiere:**
- Cambios en engine core
- Cambios en ARI
- Cambios en STT/Bridge/Snoop

---

## 📊 Logs de Trazabilidad

Cada decisión deja logs claros:

```
🔒 [LIFECYCLE] phase=LISTEN_RUT allowsSTT=true requiresSNOOP=true
🔒 [LIFECYCLE] phase=START_GREETING allowsPLAYBACK=true requiresBRIDGE=true
🔒 [LIFECYCLE] Teardown de bridge bloqueado en fase LISTEN_RUT
```

---

## 🛡️ Beneficios

### ✅ Prevención de Bugs

- Bridge no se destruye en fases incorrectas
- Snoop protegido durante LISTEN_RUT
- STT solo se inicializa cuando corresponde

### ✅ Trazabilidad

- Logs claros de decisiones
- Fases auditables
- Comportamiento determinístico

### ✅ Escalabilidad

- Agregar fases sin tocar engine
- Múltiples bots, un solo engine
- Gobernanza centralizada

---

## 🧪 Validación

### Runtime

Cada acción valida contra el contrato antes de ejecutar.

### CI/CD (Futuro)

Validar que todas las fases del dominio tienen contrato definido.

---

## 📌 Referencias

- **ADR-001:** Bridge Playback Alignment
- **ADR-002:** Voice Bridge Lifecycle
- **Issue:** RUT Detection Failure (2026-01-19)
- **Root Cause:** Lifecycle no gobernado

---

## ✅ Checklist de Implementación

- [x] Lifecycle Contract creado
- [x] Validaciones en voice-engine.js
- [x] Validaciones en ari-listener.js
- [x] Logs de trazabilidad agregados
- [x] ADR documentado

---

**Última actualización:** 2026-01-19
