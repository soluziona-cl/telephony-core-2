# 📘 DOCUMENTACIÓN DEL PROYECTO: TELEPHONY-CORE

**Fecha de Actualización**: 15 de Enero, 2026
**Ubicación**: \`/opt/telephony-core/\`
**Estado**: En Desarrollo Activo / Migración de Arquitectura

---

## 1. Descripción General

\`telephony-core\` es el sistema central de telefonía y orquestación de voicebots basado en **Asterisk (ARI)** y **Node.js**. Su propósito es gestionar llamadas telefónicas automatizadas, interactuar con usuarios mediante lenguaje natural (vía OpenAI Realtime API y Whisper), y ejecutar flujos de negocio específicos por cliente.

El sistema está transitando hacia una arquitectura de **Gobernanza Estricta (Client Capsule)**, donde el núcleo (\`core\`) es agnóstico y estable, mientras que la lógica de negocio reside en cápsulas aisladas por cliente (\`client/quintero\`, etc.).

---

## 2. Arquitectura de Software

El proyecto sigue el patrón **Core-Shell** con aislamiento estricto:

### 🌟 Core (\`/services/core\`)
- **Responsabilidad**: Manejo de bajo nivel de Asterisk, streaming de audio (UDP/RTP), integración con OpenAI, detección de voz (VAD) y manejo de sesiones.
- **Componente Principal**: \`VoiceEngine V3\` (\`engine/voice-engine.js\`).
- **Filosofía**: "Minimal, Deterministic, Safe". No contiene reglas de negocio.

### 🧠 Clientes (\`/services/client\`)
- **Responsabilidad**: Lógica de negocio, prompts, máquinas de estado, integraciones (n8n, SQL).
- **Ejemplo**: \`quintero\` (Consultorio Médico).
- **Aislamiento**: "Shared-Nothing". Un cliente no puede importar nada de otro cliente ni del legacy compartido.

### 🌐 Dominios Genéricos (\`/services/domains\`)
- **Responsabilidad**: Lógica reutilizable pero desacoplada del core y del cliente (ej. validación de RUT, consulta de agenda).
- **Uso**: Los clientes delegan tareas complejas a estos dominios explícitamente.

---

## 3. Estructura de Directorios

\`\`\`text
/opt/telephony-core/
├── services/
│   ├── core/                  # Motor central
│   │   ├── engine/            # VoiceEngine V3, OpenAI Client
│   │   ├── ari/               # Clientes ARI
│   │   ├── audio/             # Manejo de streams
│   │   ├── transcription/     # Servicios de transcripción
│   │
│   ├── client/                # Cápsulas de clientes
│   │   ├── quintero/          # Bot: Confirmación Citas Quintero
│   │   │   ├── bot/           # Lógica del bot (State Machine)
│   │   │   │   └── phases/    # Fases explícitas (ej: WAIT_RUT)
│   │   │   ├── contracts/     # Contratos de interfaz
│   │   │   ├── md/            # Documentación interna del cliente
│   │   │   └── index.js       # Entry point único
│   │   │
│   │   └── _template/         # Plantilla base para nuevos clientes
│   │
│   ├── domains/               # Módulos de negocio puros
│   │   ├── rut/               # Lógica de RUT chileno
│   │   └── agenda/            # Lógica de citas médicas
│   │
│   └── voicebot_legacy/       # [DEPRECADO] Código antiguo
│
├── recordings/                # Grabaciones de llamadas
├── scripts/                   # Scripts de mantenimiento
└── index.js                   # Punto de entrada de la aplicación
\`\`\`

---

## 4. Archivos Clave y Componentes Reseñables

### \`services/core/engine/voice-engine.js\` (Engine V3)
El corazón del sistema.
- **STT Multimodal**: Soporta \`realtime\` (OpenAI Realtime API) y \`legacy-batch\` (Grabación + Whisper).

- **Gestión de Audio**: Crea puentes (\`ActiveBridge\`) y canales \`ExternalMedia\` para derivar audio a OpenAI o grabación.
- **Defensa ante Fallos**: Detecta "Max Silence", maneja desconexiones de socket y "Fail-Closed" en errores críticos.
- **Barge-In Control**: Maneja banderas \`silent\` y \`skipInput\` para controlar interrupciones.

### \`services/client/quintero/bot/index.js\`
Orquestador del bot Quintero.
- Delega el control a \`phases/WAIT_RUT.js\` para la captura de RUT robusta.
- Interactúa con \`rutDomain\` para validaciones.
- Mantiene el estado de la conversación.

### \`services/client/quintero/contracts/CLIENT_CONTRACT.md\`
Define las reglas de juego obligatorias para el cliente.
- Prohíbe imports cruzados.
- Define la interfaz de respuesta \`ClientResponse\`.

---

## 5. Actualizaciones Recientes (Enero 2026)

### ✅ Voice Engine V3
Reescritura del motor para mayor estabilidad.
- **Soporte Batch STT**: Implementado para casos donde Realtime falla o es costoso. Graba audio local y transcribe con Whisper.
- **RTP Listening**: Servidor UDP local para capturar audio de Asterisk.
- **Improved VAD**: Mejor detección de silencios y habla.

### ✅ Gobernanza "Client Capsule" (v1.1)
- Estandarización de la estructura de carpetas de clientes.
- Separación estricta de responsabilidades.
- Creación de \`_template\` para nuevos clientes.

### ✅ Fase Explícita \`WAIT_RUT\`
- Migración de la lógica de captura de RUT de la máquina de estados gigante a una fase dedicada y aislada.
- Usa \`legacy-batch\` mode para mayor precisión en dictado de números y letras.

### 📢 Optimización UX Quintero
- **Reducción de Latencia**: Se acortó el mensaje de bienvenida (`greeting_sofia_2`) para agilizar la interacción inicial.
- **Regeneración de Audios**: Scripts actualizados y audios estáticos regenerados (`generate_quintero_audios.mjs`).
- **Confirmación de Flujo**: Se validó `state-machine.js` como el despachador central de fases.


---

## 6. Errores Conocidos y Estado Actual

### ⚠️ Problemas Activos
1.  **Echo Loop (STT oyendo TTS)**:
    - *Estado*: Mitigado.
    - *Solución*: Implementación de flags \`silent\` (no escuchar) y \`skipInput\` durante el playback. El Engine V3 pausa el STT mientras reproduce audio del sistema.

2.  **Grabación y "Max Silence Reached"**:
    - *Síntoma*: En ocasiones, el VAD no detecta audio o la grabación falla ("File not found"), provocando que el bot corte por silencio.
    - *Estado*: En corrección. Se implementó una ruta de grabación de "respaldo" continua y se ajustaron los umbrales de silencio.

3.  **Errores SQL (\`sp_GuardarGestionLlamada\`)**:
    - *Detalle*: Error por exceso de argumentos en el procedimiento almacenado.
    - *Estado*: Identificado. Requiere ajuste en \`CallFinalizer\` para alinear los parámetros con la definición de la BD.

4.  **Metadata Incompleta**:
    - *Detalle*: Algunos campos de sesión (ANI/DNIS) aparecen como \`undefined/UNKNOWN\`.
    - *Estado*: En investigación. Se reforzó el paso de metadatos en \`startVoiceBotSessionV3\`.

### 🛠️ Ajustes Pendientes
- Finalizar la migración total de fases de Quintero al modelo explícito (falta \`WAIT_BODY\` / Agenda).
- Refinar tiempos de guarda (\`POST_PLAYBACK_GUARD_MS\`) para evitar cortes prematuros.
- Limpiar código legacy (\`voicebot_legacy\`) una vez confirmada la estabilidad de V3.

---

## 7. Instrucciones Operativas

### Reiniciar Servicio
\`\`\`bash
sudo systemctl restart telephony-core
\`\`\`

### Ver Logs
\`\`\`bash
journalctl -u telephony-core -f -n 100
# O logs de aplicación directa (si se corre con node):
tail -f /opt/telephony-core/logs/app.log
\`\`\`

### Crear Nuevo Cliente
**NO crear desde cero.** Copiar el template:
\`\`\`bash
cp -r services/client/_template services/client/nuevo_cliente
\`\`\`
Y seguir las instrucciones en \`contracts/CLIENT_CONTRACT.md\`.

---
*Generado automáticamente por Antigravity AI Assistant.*
