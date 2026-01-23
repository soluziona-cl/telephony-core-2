# 🎯 Mejoras de Fluidez para Voicebots - Diseño Técnico

**Fecha:** 2025-01-19  
**Objetivo:** Convertir telephony-core en un voicebot "fluido" comparable a los estándares top del mercado

---

## 1. Problemas Identificados vs. Estándar "Top"

### A. VAD / Gating Demasiado Agresivo
**Problema actual:**
- STT recibe `speaking:true`, pero la lógica marca `NO_INPUT` muy rápido
- Se confía en VAD antes de tener "proof" de STT (delta/completed)
- Los deltas llegan después del commit periódico, pero ya se marcó NO_INPUT

**Solución:** VAD híbrido con 2 capas
- Capa 1 (rápida): `TALK_DETECT` start/stop (caller + snoop)
- Capa 2 (autoridad): `delta/completed` del STT
- **Regla:** Si hay delta → ya hay voz → NO puede haber NO_INPUT
- **NO_INPUT solo si:** no hay talk_start Y no hay delta Y no hay audioRx por X ms

### B. Deltas Solo para Timing
**Problema actual:**
- Deltas se reciben pero solo se usan para timing
- No se procesan tokens para detección temprana de RUT
- No se disparan intents tempranos ("sí", "no", "repetir")

**Solución:** Procesar deltas para tokens
- Acumular texto incremental en buffer normalizado
- Normalizar (minúscula, sin espacios, sin tildes)
- Correr parser determinístico local (`parseRutDeterministic`)
- Si detecta patrón plausible → congelar antes del completed y cortar espera

### C. Webhook Bloqueante
**Problema actual:**
- Webhook tarda ~3s y se marca como `TIMEOUT` (bug: timeout real es 5s pero se marca TIMEOUT a 2s)
- Bloquea el avance del turno
- Destruye el "feeling" del bot

**Solución:** Webhook post-commit, no in-turn blocking
- Ruta rápida (local): si parser local detecta → avanza fase inmediato
- Ruta lenta (webhook): valida/normaliza en paralelo y solo corrige si difiere
- Fix bug: `httpTimeStatus` no debe ser TIMEOUT si `httpTime < 5000ms`

### D. Endpointing Solo por Silencio
**Problema actual:**
- Termina solo cuando hay silencio >= MIN_SILENCE_MS
- No considera estabilidad de partials
- No considera puntuación o intents

**Solución:** Endpointing híbrido
- Termina si:
  - `completed` llega, O
  - Parser local detecta RUT válido, O
  - N deltas sin cambios significativos por M ms (stability window), O
  - Hard timeout (ej 4.5s como ya tienes)

### E. Reuso de Recursos
**Problema actual:**
- OpenAI Realtime session se precalienta pero se "skipped" por silent/skipInput
- Se recrea UDP listener/externalMedia por cada micro-intento

**Solución:** Preconexión persistente
- Mantener OpenAI Realtime session preconectada antes de LISTEN_RUT
- Reusar UDP listener/externalMedia cuando sea posible por llamada

---

## 2. Objetivos de Diseño (Medibles)

### Para LISTEN_RUT:
- **TTFB STT (primer delta):** < 800ms desde LISTEN_START
- **Detección de voz:** por cualquiera de (talk_detect OR delta) en < 900ms
- **Tiempo a decisión (RUT detectado o repreguntar):** < 2.5s típico
- **Barge-in:** cortar audio < 150ms desde talk_start

---

## 3. Cambios Concretos Recomendados

### 3.1 VAD Híbrido (2 Capas)

**Archivo:** `services/core/engine/voice-engine.js`

**Cambios:**
1. Modificar `waitForRealVoice` para aceptar callback de evidencia de deltas
2. Agregar función `checkDeltaEvidence()` que consulte Redis para evidencia de voz
3. Modificar lógica de NO_INPUT para verificar evidencia de deltas ANTES de marcar NO_INPUT

**Pseudo-código:**
```javascript
// En waitForRealVoice o equivalente
const hasDeltaEvidence = await checkDeltaEvidence(callKey);
if (hasDeltaEvidence) {
    return { detected: true, source: 'delta' };
}

// En lógica de NO_INPUT
if (!voiceDetected.detected) {
    // ANTES de marcar NO_INPUT, verificar deltas
    const deltaEvidence = await checkDeltaEvidence(callKey);
    if (deltaEvidence) {
        log("info", "🎤 [VAD] Voz detectada por deltas, ignorando NO_INPUT");
        voiceDetected = { detected: true, source: 'delta' };
    } else {
        // Solo ahora marcar NO_INPUT
        await delegateDomainEvent('NO_INPUT', ...);
    }
}
```

### 3.2 Procesar Deltas para Tokens

**Archivo:** `services/core/engine/voice-engine.js` (callback `onPartialTranscript`)

**Cambios:**
1. Cuando llega delta, además de guardar en Redis, procesar localmente
2. Normalizar texto acumulado
3. Ejecutar parser determinístico local
4. Si detecta RUT válido → forzar commit y avanzar

**Pseudo-código:**
```javascript
openaiClient.onPartialTranscript = async (partialText, sessionId, isDelta = false) => {
    // ... código existente ...
    
    if (isDelta && openaiClient.isIncrementalEnabled()) {
        // Acumular en buffer local
        const accumulatedText = await getPartialRut(sessionId);
        
        // Normalizar
        const normalized = normalizeRutText(accumulatedText);
        
        // Parser determinístico local
        const rutState = await getRutState(sessionId);
        if (rutState.state === IdentityState.VALIDADO && rutState.confidence >= 85) {
            log("info", `🎯 [DELTA-FIRST] RUT válido detectado temprano: "${rutState.normalized}"`);
            
            // Forzar commit y avanzar
            openaiClient.commit();
            // Marcar flag para que el engine avance sin esperar silencio
            await redis.set(`rut:early-detected:${sessionId}`, 'true', { EX: 10 });
        }
    }
};
```

### 3.3 Endpointing por Estabilidad

**Archivo:** `services/core/engine/voice-engine.js` (bloque de espera de silencio)

**Cambios:**
1. Agregar tracking de estabilidad de partials
2. Detectar cuando N deltas no cambian significativamente por M ms
3. Terminar espera de silencio si hay estabilidad

**Pseudo-código:**
```javascript
let lastPartialText = '';
let lastPartialChangeTs = Date.now();
const STABILITY_WINDOW_MS = 600; // 600ms sin cambios
const MIN_STABLE_DELTAS = 2; // Al menos 2 deltas sin cambios

const checkStability = async () => {
    const currentPartial = await getPartialRut(linkedId);
    if (currentPartial === lastPartialText) {
        const timeSinceChange = Date.now() - lastPartialChangeTs;
        if (timeSinceChange >= STABILITY_WINDOW_MS) {
            log("info", `🎯 [ENDPOINTING] Estabilidad detectada: "${currentPartial}" sin cambios por ${timeSinceChange}ms`);
            return true; // Terminar espera
        }
    } else {
        lastPartialText = currentPartial;
        lastPartialChangeTs = Date.now();
    }
    return false;
};
```

### 3.4 Webhook Post-Commit (No Blocking)

**Archivo:** `services/client/quintero/bot/capsules/phased-capsule.js` (handleProcessRut)

**Cambios:**
1. El dominio NO debe esperar webhook para avanzar
2. Si parser local detecta RUT válido → avanzar inmediato
3. Webhook se ejecuta en paralelo y solo corrige si difiere

**Pseudo-código:**
```javascript
async handleProcessRut(ctx) {
    const rutState = await getRutState(callKey);
    
    // RUTA RÁPIDA: Si parser local detecta RUT válido
    if (rutState.state === IdentityState.VALIDADO && rutState.confidence >= 85) {
        log("info", `🚀 [RUTA RÁPIDA] RUT válido detectado localmente: "${rutState.normalized}"`);
        
        // Avanzar inmediato (no esperar webhook)
        this.currentState = 'CONFIRM_RUT';
        return { action: 'SET_STATE', nextPhase: 'CONFIRM_RUT', ... };
    }
    
    // RUTA LENTA: Esperar webhook solo si no hay detección local
    const webhookResult = await waitForWebhookResult(callKey, { timeout: 2000 });
    // ... procesar webhook ...
}
```

### 3.5 Fix Bug httpTimeStatus TIMEOUT

**Archivo:** `services/client/quintero/bot/webhooks/formatRutWebhook.js` (línea 127)

**Cambio:**
```javascript
// ANTES:
httpTimeStatus: httpTime <= 300 ? 'IDEAL' : httpTime <= 600 ? 'ACEPTABLE' : httpTime <= 2000 ? 'LENTO' : 'TIMEOUT'

// DESPUÉS:
httpTimeStatus: httpTime <= 300 ? 'IDEAL' : httpTime <= 600 ? 'ACEPTABLE' : httpTime <= 2000 ? 'LENTO' : httpTime <= 5000 ? 'ACEPTABLE_LENTO' : 'TIMEOUT'
```

---

## 4. Plan de Implementación

### Fase 1: Fixes Críticos (Inmediato)
1. ✅ Fix bug `httpTimeStatus` TIMEOUT
2. ✅ Mejorar VAD híbrido (delta + talk_detect)
3. ✅ Procesar deltas para tokens tempranos

### Fase 2: Optimizaciones (Corto plazo)
4. ✅ Endpointing por estabilidad
5. ✅ Webhook post-commit (no blocking)

### Fase 3: Reuso de Recursos (Mediano plazo)
6. ✅ Preconexión persistente de OpenAI Realtime
7. ✅ Reuso de UDP listener/externalMedia

---

## 5. Métricas de Éxito

- **TTFB STT:** < 800ms (actual: ~1200ms)
- **Detección de voz:** < 900ms (actual: ~1500ms)
- **Tiempo a decisión:** < 2.5s (actual: ~4s)
- **Barge-in:** < 150ms (actual: ~300ms)
- **Webhook no bloqueante:** 100% de casos con detección local

---

## 6. Notas de Implementación

- Mantener compatibilidad hacia atrás
- No romper flujos existentes
- Agregar logging detallado para debugging
- Tests unitarios para cada mejora
