# Decisiones Arquitectónicas - Client: Quintero

## [2026-01-12] Implementación de Fase de Arranque Explícita (Turn 0)

### Contexto
El modelo anterior del bot utilizaba un audio fijo (`greeting_sofia_2`) como barrera de entrada segura, garantizando que el usuario recibiera contexto antes de que el sistema abriera el micrófono. La migración inicial al nuevo modelo basado en dominios intentó replicar esto dentro de `WAIT_BODY` usando lógica condicional, lo que resultó en condiciones de carrera (silencios ambiguos) y regresión de funcionalidad (engine escuchando antes de tiempo).

### Decisión
Se establece arquitectónicamente que **el saludo inicial DEBE ser una Fase Explícita (Turn 0)** y no un estado condicional dentro de una fase de escucha.

1.  **Nueva Fase `START_GREETING`:** Se introduce como punto de entrada único en la State Machine.
2.  **Responsabilidad Única:** Esta fase SOLO reproduce el audio (`sound:voicebot/greeting_sofia_2`) y transiciona a la siguiente fase (`WAIT_BODY`).
3.  **Prohibición en `WAIT_BODY`:** La fase de escucha (`WAIT_BODY`) ya no contiene lógica de saludo inicial. Asume que el contexto ya fue entregado.

### Consecuencias
- **Positivas:** 
    - Determinismo total en el arranque.
    - Se elimina el el riesgo de "escucha en frío".
    - Alineación 1:1 con la experiencia de usuario (UX) probada en producción.
- **Negativas:** 
    - Requiere un cambio estructural en la state machine (añadir una fase extra), pero el beneficio en estabilidad lo justifica.

### Estado
✅ Implementado y Verificado.

## [2026-01-22] ADR-002 — Gobierno de Timing y Audio Plane

**Definición de primitiva única AUDIO_READY**

### Estado
APROBADO · BLOQUEANTE · NO NEGOCIABLE

### Fecha
Enero 2026

### Autor
Arquitectura VoiceBot Mission-Critical

### Contexto
El sistema VoiceBot utiliza múltiples componentes asincrónicos y distribuidos:
*   Asterisk ARI (Channels, Bridges, Snoop)
*   Audio Plane (playback, capture, pin)
*   STT incremental
*   Engine compartido multi-dominio

Históricamente, el sistema permitió inicializaciones tempranas del audio (early init) con el objetivo de reducir latencia. Esto introdujo múltiples fuentes implícitas de “readiness”, generando inconsistencias entre:
*   El contrato lógico del Snoop
*   El plano físico del audio (bridge / pin / capture)

Como resultado, se detectaron:
*   Transiciones de estado inválidas
*   Bloqueos intermitentes de STT
*   Guards, retries y timeouts artificiales
*   Sensación de inestabilidad en flujos productivos

### Problema Identificado
El sistema no tenía una única fuente de verdad para determinar cuándo:
*   El audio puede consumirse
*   El STT puede inicializarse
*   El dominio puede entrar en escucha efectiva

Esto permitió comportamientos como:
*   Anclar audio (pin) antes de que el Snoop estuviera listo
*   Interpretar estados no definidos en el contrato
*   Desacoplar lifecycle lógico y físico

### Decisión Arquitectónica
✅ Se define oficialmente AUDIO_READY como la única primitiva válida para:
*   Consumo de audio
*   Inicialización de STT
*   Inicio de fases de escucha
*   Activación de VAD
*   Transiciones dominio → escucha

### Definición Formal de AUDIO_READY
AUDIO_READY es una condición explícita, binaria y determinística que indica que:
**El sistema está autorizado a consumir audio de forma segura.**

**AUDIO_READY = TRUE SI Y SOLO SI:**
1.  El Snoop recibió StasisStart
2.  El contrato del Snoop está en estado READY
3.  El Snoop fue registrado correctamente en el Audio Plane
4.  No existen transiciones pendientes del lifecycle
5.  El engine ha emitido explícitamente el evento AUDIO_READY

### Prohibiciones Absolutas
A partir de este ADR queda terminantemente prohibido:
❌ Consumir audio si AUDIO_READY !== true
❌ Inicializar STT sin AUDIO_READY
❌ Ejecutar pin, capture, listen o vad antes de AUDIO_READY
❌ Inferir readiness por heurísticas o timing
❌ Usar estados no definidos en el contrato (ANCHORED, PINNED, etc.)
❌ Interpretar readiness desde el dominio

### Fuente Única de Verdad
| Aspecto | Fuente |
| :--- | :--- |
| Ready lógico | Contrato del Snoop (READY) |
| Ready físico | Evento AUDIO_READY |
| Orden | Engine |
| Decisión de escucha | Dominio (posterior a AUDIO_READY) |

### Flujo Canónico (OBLIGATORIO)
```
CREATE SNOOP
   ↓
WAIT STASIS START
   ↓
SNOOP → READY
   ↓
ENGINE EMITE AUDIO_READY
   ↓
DOMINIO AUTORIZADO A ESCUCHAR
   ↓
STT / VAD / INPUT
```
Cualquier desviación de este flujo se considera violación de arquitectura.

### Responsabilidades por Capa
**⚙️ Engine (Core)**
✔️ Crear y gobernar Snoop
✔️ Validar contrato de estados
✔️ Emitir AUDIO_READY
✔️ Bloquear audio hasta AUDIO_READY
❌ Decidir UX
❌ Interpretar dominio

**🧠 Dominio (Bot-Specific)**
✔️ Decidir qué hacer cuando existe AUDIO_READY
✔️ Iniciar escucha solo después
✔️ Manejar reintentos y UX
❌ Forzar audio
❌ Inferir readiness

### Blindaje para Futuros Bots
Este ADR aplica a:
*   Todos los bots actuales
*   Todos los bots futuros
*   Todos los dominios
*   Todos los entornos (dev / qa / prod)

**Beneficios directos:**
🧱 Un solo modelo mental
🔒 Engine estable y compartido
🚫 Cero regresiones por timing
🧪 Flujos auditable y determinísticos
🚀 Escalabilidad multi-bot real

### Reglas de Validación (Checklist)
Antes de aprobar cualquier cambio:
⬜ ¿Existe AUDIO_READY explícito?
⬜ ¿STT inicia solo después?
⬜ ¿No se usan estados inventados?
⬜ ¿El dominio no fuerza audio?
⬜ ¿El engine no interpreta UX?

❌ Si algún punto falla → Cambio rechazado

### Consecuencias
**Positivas:**
*   Estabilidad sistémica
*   Eliminación de bugs intermitentes
*   Arquitectura predecible
*   Menos guards y retries

**Negativas (aceptadas):**
*   Ligerísimo aumento de latencia inicial
*   Prohibición de early hacks

### Cierre
Este ADR elimina la ambigüedad del audio y establece un contrato inquebrantable.
**Sin AUDIO_READY, no existe audio.**
Este principio es global, definitivo y obligatorio.
