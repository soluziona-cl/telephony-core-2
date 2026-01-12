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
