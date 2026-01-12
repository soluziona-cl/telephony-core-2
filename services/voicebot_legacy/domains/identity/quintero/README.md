# Voicebot Quintero

## Dominio
Confirmación de identidad por RUT para atención médica en Consultorio Médico de Quintero.

## Reglas
- **Confirmación máxima**: 2 intentos
- **Aceptación implícita**: Permitida después de 2 intentos ambiguos
- **UX adulto mayor**: Mensajes claros, pausados y empáticos
- **ASR tolerante**: Acepta variaciones en transcripciones
- **STRICT MODE**: Solo en fases CONFIRM y WAIT_DV

## Estados
```
WAIT_BODY → WAIT_DV → CONFIRM → COMPLETE
     ↓         ↓         ↓
   FAILED    FAILED    FAILED
```

### WAIT_BODY
Espera captura del RUT completo (body + dígito verificador).

**Transiciones:**
- RUT completo válido → `CONFIRM`
- RUT completo con DV no válido → `CONFIRM` (pedir confirmación)
- Solo body capturado → `WAIT_DV`
- Sin captura después de 3 intentos → `FAILED`

### WAIT_DV
Espera solo el dígito verificador.

**Transiciones:**
- DV válido → `CONFIRM`
- DV no válido → `CONFIRM` (pedir confirmación)
- Sin captura después de 3 intentos → `FAILED`

### CONFIRM
Confirma el RUT detectado con el usuario.

**Transiciones:**
- Usuario confirma (SÍ) → `COMPLETE`
- Usuario rechaza (NO) → `WAIT_BODY` (reiniciar)
- Respuesta ambigua después de 2 intentos → `COMPLETE` (aceptación implícita)
- Corrección de DV → permanece en `CONFIRM`

### COMPLETE
RUT validado exitosamente. El bot puede continuar con otras tareas.

## Archivos

```
quintero/
├── index.js              # Entry point del bot
├── config.js             # Configuración (retries, timeouts, UX)
├── state-machine.js      # Máquina de estados
├── handlers/             # Handlers por fase
│   ├── wait-body.js
│   ├── wait-dv.js
│   └── confirm.js
├── rut/                  # Utilidades RUT
│   ├── rut-parser.js
│   ├── rut-validator.js
│   └── rut-normalizer.js
├── tts/                  # Mensajes TTS
│   └── messages.js
└── prompts/              # Prompts para LLM
    └── quintero-confirmacion.txt
```

## Integración

El bot se activa cuando el modo es `voicebot_identity_quintero`:

```javascript
// En el handler inbound
const mode = "voicebot_identity_quintero";
const domain = resolveDomain(mode); // → identityDomain
const bot = await domain({ botName: 'quintero', ... });
```

## Testing

Para probar el bot:

1. Llamar con modo `voicebot_identity_quintero`
2. Decir un RUT completo (ej: "catorce millones, trescientos cuarenta y ocho mil, doscientos cincuenta y ocho, guión ocho")
3. Confirmar cuando el bot pregunte
4. Verificar que el bot encuentra al paciente en la BD

