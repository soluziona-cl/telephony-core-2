# 🔍 Análisis Forense: RUT No Detectado

**Fecha:** 2026-01-19  
**Sesión:** 1768851953.963  
**Problema:** Sistema no detecta RUT cuando el usuario lo indica

---

## 1) CONTEXTO GENERAL DEL FLUJO

Tipo de llamada: Inbound  
Dominio/Bot: Quintero (voicebot_quintero_query)  
Objetivo: Greeting → LISTEN_RUT → Captura RUT con STT incremental  
Componentes activos: Engine V3, Dominio Quintero (phased capsule), ARI (Stasis/Bridge/Snoop), STT Realtime (OpenAI V3 Incremental), Redis (buffer incremental)

---

## 2) SECUENCIA CRONOLÓGICA RESUMIDA

T0 → Canal entra a Stasis, Snoop RX creado (1768851953.964)  
T1 → Rol asignado inmediatamente, protección 500ms completada  
T2 → Voice Bridge creado, caller agregado, playback BVDA iniciado  
T3 → Playback completado (9046ms), Turn 1 (silent, skipInput)  
T4 → LISTEN_RUT activa STT, intenta agregar Snoop al Capture Bridge  
T5 → Snoop (1768851953.964) ya no existe → STT initialization falla  
T6 → Sistema usa canal principal (1768851953.963) para STT  
T7 → VAD no detecta voz, Redis sin buffer parcial → NO_INPUT  
T8 → Snoop finalizado a los 21s, llamada termina por silencio máximo

---

## 3) COSAS QUE FUNCIONAN CORRECTAMENTE

✅ [ARI] Conexión estable, eventos completos  
✅ [Snoop] Canal RX creado correctamente (1768851953.964)  
✅ [Voice Bridge] Creado y caller agregado correctamente  
✅ [Playback BVDA] Reproducido correctamente (9046ms, PlaybackStarted recibido)  
✅ [Rol] Asignado inmediatamente, previene hangup temprano  
✅ [Dominio] Control de fases correcto, LISTEN_RUT activada

---

## 4) ERRORES Y ANOMALÍAS DETECTADAS

❌ [STT] Canal Snoop no existe cuando se intenta agregar al Capture Bridge  
📌 Evidencia:
```
16:46:03.660Z [WARN] ⚠️ [STT INIT] Canal 1768851953.964 ya no existe (hangup temprano), omitiendo agregar al bridge
16:46:03.660Z [WARN] ⚠️ [STT INIT] No se pudo agregar canal 1768851953.964 al bridge (hangup temprano), omitiendo inicialización STT
```

❌ [STT] STT initialization falla, sistema usa canal principal en lugar de Snoop  
📌 Evidencia:
```
16:46:03.661Z [INFO] 🎧 [STT] Escuchando (Streaming) en canal 1768851953.963
```
El sistema usa el canal principal (1768851953.963) en lugar del Snoop (1768851953.964).

❌ [VAD] VAD no detecta voz del usuario  
📌 Evidencia:
```
16:46:05.010Z [WARN] ⚠️ [INCREMENTAL RUT] VAD no detectó voz y Redis no tiene buffer parcial
```

❌ [AUDIO] No hay evidencia de audio fluyendo al STT  
📌 Evidencia:
El log no muestra ningún `[STT][RX] Audio recibido` después de que el STT se inicializa, indicando que el audio no está fluyendo al STT.

---

## 5) COMPORTAMIENTOS SOSPECHOSOS / RIESGOS

⚠️ [STT] Sistema usa canal principal en lugar de Snoop cuando el Snoop no existe  
⚠️ [SNOOP] Snoop se finaliza antes de que el STT pueda inicializarse  
⚠️ [AUDIO] No hay evidencia de audio fluyendo al STT (no hay logs de `[STT][RX] Audio recibido`)  
⚠️ [PRE-WARM] STT pre-warm se salta porque `nextPhase=START_GREETING` en lugar de `LISTEN_RUT`

---

## 6) CAUSA RAÍZ (ROOT CAUSE)

🎯 Causa raíz:  
El canal Snoop (1768851953.964) se finaliza antes de que el STT pueda agregarlo al Capture Bridge durante la inicialización lazy. El sistema falla a usar el canal principal, pero el audio no fluye correctamente porque el canal principal está en el Voice Bridge y no está cableado al Capture Bridge para STT.

---

## 7) IMPACTO REAL EN EL USUARIO FINAL

📞 Impacto:  
El usuario indica su RUT, pero el sistema no lo detecta porque el STT no está capturando audio correctamente. El bot no responde y la llamada termina por silencio máximo sin capturar el RUT.

---

## 8) QUÉ NO ES EL PROBLEMA

🚫 No es:
- Un problema de playback BVDA (funciona correctamente)
- Un problema del dominio Quintero (LISTEN_RUT se activa correctamente)
- Un problema de Redis o SQL
- Un problema de OpenAI o STT engine (no se inicializa porque el Snoop no existe)
- Un problema de VAD en sí (no hay audio para detectar)

---

## 9) RECOMENDACIONES TÉCNICAS (SIN IMPLEMENTAR)

🛠️ Recomendaciones:

1. Pre-warm el STT durante el greeting cuando se detecta que la siguiente fase será LISTEN_RUT  
   Motivo: El log muestra que el STT se inicializa de forma lazy (solo cuando se necesita), pero el Snoop ya no existe cuando se intenta inicializar.

2. Usar el canal principal como fallback si el Snoop no está disponible, pero asegurando que el audio fluya correctamente  
   Motivo: El log muestra que el sistema intenta usar el canal principal, pero no hay evidencia de audio fluyendo al STT.

3. Verificar que el Snoop se mantenga vivo durante toda la sesión de LISTEN_RUT  
   Motivo: El log muestra que el Snoop se finaliza a los 21 segundos, pero el STT intenta usarlo a los 3 segundos.

---

## 10) RESUMEN EJECUTIVO FINAL

El Snoop se finaliza antes de que el STT pueda inicializarse, causando que el sistema use el canal principal en lugar del Snoop. Sin el Snoop correctamente cableado, el audio no fluye al STT, resultando en VAD sin detección y RUT no capturado.
