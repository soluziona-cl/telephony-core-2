---
description: ANEXO · IMPLEMENTATION PLAN HARDENING
---

📎 ANEXO · IMPLEMENTATION PLAN HARDENING
(Voicebot Sunset & Core Extraction · Bloqueante · Client-First Runtime)

Este anexo complementa el “Implementation Plan: Voicebot Sunset & Core Extraction”.
Su objetivo es volver el plan AUTO-DEFENSIVO y CERO-REGRESIÓN.
Si un punto de este anexo no se cumple → la migración se considera INVÁLIDA.

────────────────────────────────────────
0) DECISIÓN DE NOMENCLATURA (BLOQUEANTE)
────────────────────────────────────────

Estado actual del repo:
- Existe /services/dominio/<CLIENT_ID>/

Regla:
- “dominio” aquí representa CLIENTE (cápsula).
- La arquitectura objetivo se denomina “client-first”.

Acción permitida:
- Mantener /services/dominio temporalmente.
- El router debe soportar uno de estos modos (definir uno y mantenerlo coherente):

  MODO A (preferido): /services/client/<CLIENT_ID>/
  MODO B (transitorio): /services/dominio/<CLIENT_ID>/

Prohibición:
- No pueden coexistir dos fuentes activas para el mismo cliente.
  Si quintero vive en dominio, NO puede existir quintero en client al mismo tiempo.

────────────────────────────────────────
1) CRITERIOS DE “DONE” (GATES BLOQUEANTES)
────────────────────────────────────────

Antes de mover services/voicebot a legacy, deben cumplirse TODOS:

GATE A — Dependencias
☐ CERO imports a “services/voicebot” en runtime path
☐ CERO imports a “services/voicebot/shared”
☐ CERO rutas de fallback al engine legacy
☐ Router client-first funcionando y único

GATE B — Core limpio
☐ services/core NO importa desde services/dominio|client
☐ services/core NO conoce fases, prompts, SQL ni UX
☐ services/core solo ejecuta contratos explícitos

GATE C — Cliente operativo
☐ Inbound quintero funciona end-to-end
☐ Logs confirman: router → client capsule → engine-adapter → core/engine
☐ No se generan logs desde services/voicebot

Si falla un solo ítem → NO se corta.

────────────────────────────────────────
2) REGLA DE EXTRACCIÓN A CORE (QUÉ ENTRA / QUÉ NO ENTRA)
────────────────────────────────────────

Core permite SOLO infraestructura pura:

✅ PERMITIDO en services/core:
- Loop de ejecución (engine)
- ARI listener y transporte
- Control/monitoreo telephony
- Grabación
- Utilidades de audio genéricas (sin UX)
- Transcripción post-llamada (infra)
- Helpers técnicos sin decisión (parseos, formatos técnicos)

❌ PROHIBIDO en services/core:
- Prompts
- Clasificadores de intención
- SQL queries del negocio
- Webhook clients del negocio
- State machine / handlers
- Lógica de “cuándo hablar/callar”
- Reintentos, UX, negocio

Regla:
- Si “decide” algo → pertenece al CLIENTE.
- Si “solo ejecuta” → puede pertenecer al CORE.

────────────────────────────────────────
3) ENTRYPOINT Y ROUTER (NO FALLBACK FORMAL)
────────────────────────────────────────

Se define el router único:

/services/router/client-entry-router.js

Requisitos:
- Resuelve: CallContext → CLIENT_ID
- Carga: /services/(dominio|client)/<CLIENT_ID>/inbound/engine-adapter.js
- Si el cliente NO existe → FAIL-CLOSED (throw / rechazo)
- PROHIBIDO: fallback a services/voicebot o engines legacy

El entrypoint del sistema (index.js / telephony-controller.js) debe:
- Importar SOLO el router nuevo
- No contener rutas alternativas

────────────────────────────────────────
4) VERIFY_MIGRATION.js (HARDENING OBLIGATORIO)
────────────────────────────────────────

verify_migration.js debe FALLAR si detecta:

A) Imports ilegales
- Cualquier “services/voicebot”
- Cualquier “services/voicebot/shared”
- Cualquier “voicebot-domain-router”
- Cualquier “voicebot-handler-inbound” legacy

B) Archivos sueltos (enforcement de estructura)
- Archivos JS sueltos en /services/ que pertenecen a infraestructura deben estar en /services/core/*
- Prohibido crear nuevos “*_copy.js”, “*_back.js” fuera de /services/legacy

C) Cruces entre clientes
- Imports desde /services/(dominio|client)/A hacia /services/(dominio|client)/B

D) Fuente única por cliente
- Si existe quintero en dominio y quintero en client → FAIL

Salida requerida:
- Reporte por categoría (IMPORTS / STRUCTURE / ISOLATION / SSOT)
- Código de salida != 0 ante cualquier infracción

────────────────────────────────────────
5) PROCEDIMIENTO DE CUTOVER (CONTROLADO)
────────────────────────────────────────

El cutover se ejecuta solo tras GATES A/B/C:

Paso 1 — Congelar voicebot
- Crear /services/voicebot/README.md: LEGACY · READ ONLY · NO FEATURES

Paso 2 — Extraer core
- Mover engine a /services/core/engine/voice-engine.js
- Mover ARI a /services/core/ari/
- Mover telephony a /services/core/telephony/
- Mover transcription a /services/core/transcription/
- (Opcional) /services/core/audio/ solo si NO hay UX

Paso 3 — Router + entrypoint
- Activar client-entry-router.js
- Confirmar NO fallback

Paso 4 — Verificación
- Ejecutar verify_migration.js (debe pasar 100%)
- Prueba runtime inbound quintero

Paso 5 — Sunset (frío)
- Mover: services/voicebot → services/legacy/voicebot
- Monitorear al menos 1 ciclo operacional (sin mencionar tiempos en documentación técnica; usar criterio “N despliegues estables”)

Paso 6 — Eliminación final
- Solo si no hay referencias y el legacy no se usa:
  rm -rf services/legacy/voicebot

────────────────────────────────────────
6) ROLLBACK (OBLIGATORIO)
────────────────────────────────────────

Rollback permitido SOLO antes de eliminación final:

- Si falla runtime tras mover a legacy:
  revertir movimiento (legacy → voicebot) y restaurar entrypoint previo (si existe en control de versiones)

Requisito:
- Toda modificación de entrypoint debe ser 100% reversible por Git (no manual patches).

────────────────────────────────────────
7) DOCUMENTACIÓN MÍNIMA (BLOQUEANTE)
────────────────────────────────────────

Antes del cutover:
☐ /services/core/engine/ENGINE_GOVERNANCE.md existe (copiado de V3_ENGINE_GOVERNANCE.md)
☐ Cada cliente tiene /md/DECISIONS.md actualizado indicando:
   - qué se movió
   - por qué
   - impacto
   - rollback

────────────────────────────────────────
CIERRE
────────────────────────────────────────

Este anexo convierte el plan en:
- FAIL-CLOSED
- NO FALLBACK
- SSOT real
- Aislamiento verificable
- Sunset controlado
