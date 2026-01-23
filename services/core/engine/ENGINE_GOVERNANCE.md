
# 🦅 INSTRUCCIÓN OFICIAL DE MODIFICACIÓN — VOICEBOT ENGINE V3

**Clasificación**: 🔴 Mission-Critical Fix
**Objetivo**: Eliminar duplicidad de audio, persistencia de canales y ejecución post-mortem.

## 🧠 ALCANCE PERMITIDO
- ✔️ Se modifica SOLO el lifecycle del Engine V3
- ❌ NO se modifican: Prompts, Dominios, Webhooks, Clasificadores.

## 🔒 REGLAS V3-LIFECYCLE (OBLIGATORIAS)

### 🔴 REGLA V3-F01 — FASE COMPLETE ES TERMINAL REAL
Cuando la fase es COMPLETE, el engine NO entra al loop de turnos.
```javascript
if (phase === 'COMPLETE') {
  logger.info('[ENGINE] COMPLETE detectado, evitando loop de turnos');
  break;
}
```

### 🔴 REGLA V3-F02 — UN SOLO ORIGEN DE TTS EN COMPLETE
En fase COMPLETE, solo el dominio puede generar TTS. El engine no debe "inventar" despedidas ni procesar fallbacks.

### 🔴 REGLA V3-F03 — END_CALL ES SINCRÓNICO AL PLAYBACK
El hangup SIEMPRE ocurre después del último audio, nunca antes, nunca en paralelo.
```javascript
await playAudio(finalTts);
logger.info('[ENGINE] Último audio reproducido, colgando canal');
await safeHangup(channelId);
```

### 🔴 REGLA V3-F04 — FLAG DE SESIÓN TERMINADA
Una sesión terminada NO procesa absolutamente nada más.
```javascript
session.terminated = true;
```

### 🔴 REGLA V3-F05 — BLOQUEO DE HEALTHCHECK POST-COMPLETE
Guard global en todos los handlers asíncronos:
```javascript
if (session.terminated) {
  logger.debug('[ENGINE] Evento ignorado: sesión terminada');
  return;
}
```

## 🔒 REGLAS DE PODER - AUDIO & SNOOP (NO NEGOCIABLES)

### 🔴 REGLA V3-A01 — GOLDEN RULE: AUDIO_READY
### 🔴 REGLA V3-A01 — GOLDEN RULE: AUDIO_READY (UPDATED)
La definición de "Audio Listo" depende del tipo de fuente:

**A. Para Snoop RX (Canales espía)**:
- **Fuente de Verdad**: `StasisStart` recibido (Contrato == READY).
- **Validación Física**: ❌ PROHIBIDA (`channels.get()` no es confiable para canales app-snoop).
- **Criterio**: Si el contrato dice READY, el audio está fluyendo.

**B. Para Canales Directos (Caller)**:
- **Fuente de Verdad**: `channels.get() === Up`.

```javascript
// Implementación Canónica Actualizada
if (isSnoop) {
   // Trust Contract Only
   if (contract.state === READY) proceed();
} else {
   // Trust Physical
   if (channel.state === Up) proceed();
}
```

## 🧪 CRITERIOS DE ACEPTACIÓN
1. El texto final se escucha una sola vez.
2. La llamada se corta inmediatamente al terminar el audio.
3. No existen logs después de END_CALL.
4. No hay warnings de "Channel not found".
5. STT inicia en <300ms tras el saludo (sin retries de 500ms).

---

# 🛡️ PROMPT OPERATIVO PARA FUTURAS MODIFICACIONES (V3)

**ROL**: Arquitecto de Sistemas VoiceBot Mission-Critical.

**OBJETIVO**: Analizar incidentes en VoiceBot V3 y proponer soluciones sin regresiones.

**REGLAS ABSOLUTAS**:
- El engine es compartido y no conoce dominio.
- El dominio controla negocio, el engine controla lifecycle.
- Solo se permite modificar el engine para errores de lifecycle.
- Cualquier solución debe ser explícita, defensiva y aislada.

**PROCEDIMIENTO**:
1. Identificar si el error es de dominio o de lifecycle.
2. Determinar si existe ejecución post-hangup.
3. Proponer solución que introduzca estado terminal único (`terminated=true`).
4. Validar que no afecta otros dominios ni cambia UX.

**SI LA SOLUCIÓN IMPLICA CAMBIAR ENGINE**:
Justificar explícitamente que es **lifecycle-only**. De lo contrario, RECHAZAR.
