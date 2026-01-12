# 🛡️ Fix: Anti-Replay Guardrail para TTS Duplicados

## 🚨 Problema Critico
El Engine V3, debido a su diseño de re-evaluación en "Strict Mode" o bucles de espera, tiende a ejecutar la lógica del dominio múltiples veces para la misma fase.
Si el handler del dominio retorna `ttsText` (como es estándar en fases de espera como `ASK_SPECIALTY`), el Engine reproduce el audio nuevamente, causando:
- 🔁 Repetición inmediata del audio ("Gracias, señor Christian... Gracias, señor Christian...")
- Mal experiencia de usuario (particularmente en adultos mayores con tiempos de respuesta lentos).

## 🧱 Restricción de Arquitectura
**Regla Absoluta:** No se puede modificar `voicebot-engine-inbound-v3.js`.
Por tanto, la solución debe ser **100% en el Dominio**, haciendo que el dominio sea "consciente" de lo que ya habló.

## ✅ Solución Implementada: State-Aware Anti-Replay

Se implementó un mecanismo de memoria en `state-machine.js` que rastrea la última emisión de TTS.

### 1. Estado de Sesión (`initialState`)
Se agregaron dos variables de control:
```javascript
lastTtsPhase: null, // Última fase para la cual se emitió TTS
lastTtsText: null   // Último texto exacto emitido
```

### 2. Guardrail en Orquestación (`runState`)
Antes de retornar el comando al Engine, se verifica si estamos ordenando **reproducir lo mismo** para la **misma fase** que acabamos de ejecutar.

**Lógica:**
```javascript
// Si hay orden de hablar (ttsText)
if (result.ttsText) {
  // Verificar si es un duplicado exacto (Mismsa Fase + Mismo Texto)
  if (state.lastTtsPhase === result.nextPhase && state.lastTtsText === result.ttsText) {
    // 🛑 ES DUPLICADO: Silenciar
    log("warn", `🔇 [STATE MACHINE] TTS Duplicado detectado para fase ${result.nextPhase}. Silenciando.`);
    result.ttsText = null;
  } else {
    // ✅ ES NUEVO o DIFERENTE (e.g. Retry): Permitir y Guardar
    state.lastTtsPhase = result.nextPhase;
    state.lastTtsText = result.ttsText;
  }
}
```

## 🎯 Resultado
- **Loop de espera (`ASK_SPECIALTY` -> input vacío -> `ASK_SPECIALTY`):**
  - Turno 1: Habla "Gracias...". Guarda estado.
  - Turno 2 (Re-evaluación): Intenta hablar "Gracias...". Detecta identidad. **Se silencia.**
  - **Resultado:** El usuario solo escucha el audio una vez.
  
- **Reintentos (`WAIT_BODY` -> error -> `WAIT_BODY`):**
  - Turno 1: Habla "Deme su RUT".
  - Turno 2 (Error): Habla "RUT inválido, repita".
  - Detecta fase igual (`WAIT_BODY`) pero texto **diferente**.
  - **Resultado:** ✅ Permite el mensaje de error/reintento.

Esta solución cumple con **"Una fase puede emitir TTS solo una vez por transición (evento único)"**, respetando la inmutabilidad del Engine.
