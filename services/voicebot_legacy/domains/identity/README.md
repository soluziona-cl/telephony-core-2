# Identity Domain

## Objetivo
Identificación segura del usuario antes de cualquier gestión.

## Reglas generales
- Confirmación limitada (máximo 2 intentos)
- Tolerancia ASR (acepta variaciones en transcripciones)
- Validaciones formales (RUT, documentos)
- UX optimizada para adultos mayores

## Bots

### quintero
Bot de identificación por RUT para Consultorio Médico de Quintero.

**Características:**
- Captura de RUT completo (body + dígito verificador)
- Validación matemática del dígito verificador
- Confirmación con aceptación implícita después de 2 intentos
- Búsqueda de paciente en base de datos
- Mensajes TTS optimizados para adultos mayores

**Estados:**
- `WAIT_BODY` → Esperando RUT completo
- `WAIT_DV` → Esperando solo dígito verificador
- `CONFIRM` → Confirmando RUT detectado
- `COMPLETE` → RUT validado exitosamente
- `FAILED` → Error en captura/validación

**Configuración:**
- Máximo 3 intentos para captura de RUT
- Máximo 2 intentos para confirmación
- Aceptación implícita habilitada

### default
Bot por defecto para identificación genérica.

## Uso

El dominio se activa cuando el modo comienza con `voicebot_identity_`:

```
voicebot_identity_quintero → Bot Quintero
voicebot_identity_default → Bot por defecto
```

