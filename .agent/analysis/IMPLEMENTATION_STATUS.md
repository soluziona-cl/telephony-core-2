# 🛠️ ESTADO DE IMPLEMENTACIÓN - Fixes Audio-Safe Gate

**Fecha:** 2026-01-22  
**Análisis:** log-analysis-2026-01-22-13-49-44.md

---

## ✅ IMPLEMENTADO (PRIORIDAD 0)

### 1. Redefinir `ensureAudioReady()` - EVENTOS COMO FUENTE DE VERDAD
**Archivo:** `services/core/engine/voice-engine.js` líneas ~1022-1095

**Cambios:**
- ✅ Usa `SnoopContract.state === READY` como condición principal (StasisStart ya recibido)
- ✅ Verifica correlación: `contract.snoopId === snoopId` y `contract.parentChannelId` válido
- ✅ `channels.get()` degradado a telemetría best-effort (no bloqueante)
- ✅ Timeout reducido de 5000ms a 2000ms (solo espera contrato, no ARI REST)
- ✅ Logging mejorado con `sourceOfTruth: 'SnoopContract_READY'`

**Resultado:** Audio-Safe Gate ya no bloquea por `channels.get()` fallido. Usa eventos como fuente de verdad.

---

### 2. Corregir Logging de Transición SnoopContract
**Archivo:** `services/core/engine/contracts/snoop.contract.js` líneas ~208-257

**Cambios:**
- ✅ Log usa `effectiveFrom` (estado real) en lugar de parámetro `from`
- ✅ Log refleja transición real: `WAITING_AST → READY` (no `CREATED → READY`)
- ✅ Incluye `requestedFrom` y `from` (real) en metadata para auditoría

**Resultado:** Logs de transición reflejan estado real, facilitando auditoría forense.

---

### 3. Mejorar Lectura de Rol en Hangup
**Archivo:** `services/core/ari/ari-listener.js` líneas ~1503-1510

**Cambios:**
- ✅ Lee rol desde `activeCall:${channel.id}` (fuente de verdad)
- ✅ Fallback a detección A-leg/B-leg solo si no hay rol en activeCall
- ✅ Warning solo si realmente no hay rol definido

**Resultado:** Rol consistente en hangup, mejor trazabilidad.

---

## ⏳ PENDIENTE (PRIORIDAD 1-2)

### 4. Eliminar Turn Silente Post-Playback
**Archivo:** `services/core/engine/voice-engine.js`  
**Ubicación:** Buscar `advanceTurnAfterPlayback` o handler de `PlaybackFinished`

**Acción requerida:**
- Cambiar fase a LISTEN_RUT inmediatamente después de playback
- O emitir evento interno que ejecute SET_STATE sin transcript vacío

---

### 5. Emitir LISTEN_END Sintético en Hangup
**Archivo:** `services/core/engine/voice-engine.js` (cleanup/hangup handler)

**Acción requerida:**
- En cleanup, verificar si hay segmento activo con LISTEN_START
- Si existe sin LISTEN_END → emitir LISTEN_END con reason=hangup

---

### 6. Log Único de Invariantes al Final de Llamada
**Archivo:** `services/core/engine/voice-engine.js` (finalización de sesión)

**Acción requerida:**
- Agregar log: `INVARIANTS: voiceBridge=OK, snoop=READY, ariGet=FAIL, audioReady=OK(by_event), stt=BLOCKED(gate), role=INCONSISTENT, segments=INCOMPLETE`

---

## 🎯 IMPACTO ESPERADO

Con los fixes implementados (1-3), el sistema debería:
- ✅ Permitir STT init cuando Snoop está READY por eventos (no bloquear por ARI REST)
- ✅ Logs de transición reflejan estado real (mejor auditoría)
- ✅ Rol consistente en hangup (mejor trazabilidad)

**Próximo test:** Verificar que STT se inicializa correctamente y captura RUT cuando usuario habla.

---

**FIN DEL ESTADO DE IMPLEMENTACIÓN**
