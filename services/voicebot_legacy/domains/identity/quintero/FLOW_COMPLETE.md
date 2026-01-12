# 🔄 Flujo Completo Post-Validación - Quintero

## 📊 Estado Actual

✅ **Implementado completamente** - El dominio Quintero ahora orquesta todo el flujo de agendamiento sin usar `WITH_QUERY`.

## 🔁 Flujo Completo

```
1. WAIT_BODY → Captura RUT
   ↓
2. CONFIRM → Confirma RUT
   ↓
3. VALIDATE_PATIENT → Valida paciente (webhook)
   ↓
4. ASK_SPECIALTY → Pregunta especialidad
   ↓
5. PARSE_SPECIALTY → Interpreta especialidad
   ↓
6. ASK_DATE → Pregunta fecha
   ↓
7. CHECK_AVAILABILITY → Busca horas (webhook)
   ↓
8. INFORM_AVAILABILITY → Informa hora disponible
   ↓
9. CONFIRM_APPOINTMENT → Confirma con usuario
   ↓
10. FINALIZE → Confirma vía webhook y cierra
```

## 📋 Handlers Implementados

### 1. `ask-specialty.js`
- **Fase:** `ASK_SPECIALTY`
- **Función:** Pregunta al usuario qué especialidad necesita
- **TTS:** "Gracias, señor [nombre]. ¿Para qué especialidad médica necesita agendar su hora?"
- **Siguiente:** `PARSE_SPECIALTY`

### 2. `parse-specialty.js`
- **Fase:** `PARSE_SPECIALTY`
- **Función:** Clasifica la especialidad mencionada
- **Mapeo:** Medicina General, Odontología, Pediatría, Ginecología, etc.
- **Siguiente:** `ASK_DATE` (si encuentra) o repite pregunta

### 3. `ask-date.js`
- **Fase:** `ASK_DATE`
- **Función:** Consulta fecha deseada
- **Clasificación:** Hoy, Mañana, Lo antes posible, Fecha específica
- **Siguiente:** `CHECK_AVAILABILITY`

### 4. `check-availability.js`
- **Fase:** `CHECK_AVAILABILITY`
- **Función:** Llama webhook `GET_NEXT_AVAILABILITY`
- **Manejo:** 
  - ✅ Hora encontrada → `INFORM_AVAILABILITY`
  - ❌ No hay horas → `FAILED` o `ASK_SPECIALTY` (si especialidad no mapeada)
- **Siguiente:** `INFORM_AVAILABILITY`

### 5. `inform-availability.js`
- **Fase:** `INFORM_AVAILABILITY`
- **Función:** Informa la hora disponible al usuario
- **Formato:** "Encontré disponibilidad para [especialidad] [fecha] a las [hora] con [doctor]. ¿Desea confirmar?"
- **Siguiente:** `CONFIRM_APPOINTMENT`

### 6. `confirm-appointment.js`
- **Fase:** `CONFIRM_APPOINTMENT`
- **Función:** Confirma la hora con el usuario
- **Clasificación:** YES → `FINALIZE`, NO → `ASK_DATE`, UNKNOWN → aceptación implícita después de 2 intentos
- **Siguiente:** `FINALIZE` o `ASK_DATE`

### 7. `finalize.js`
- **Fase:** `FINALIZE`
- **Función:** Confirma la hora vía webhook `CONFIRM_AVAILABILITY` y cierra
- **Manejo:**
  - ✅ Confirmado → Cierra con mensaje de éxito
  - ❌ Hold expirado → Vuelve a `ASK_DATE`
  - ❌ Error → `FAILED`
- **Siguiente:** `COMPLETE` (cierre)

## 🎯 Características Clave

### ✅ Determinístico
- Todo el flujo está controlado por el dominio
- No hay improvisación del LLM
- Cada fase tiene un handler específico

### ✅ Auditable
- Cada transición se loguea explícitamente
- Estado persistido en cada paso
- Webhooks documentados

### ✅ Reutilizable
- Patrón estándar para cualquier consultorio
- Solo cambian textos y webhooks
- Misma estructura de fases

### ✅ Sin Dependencia de WITH_QUERY
- El dominio orquesta todo
- No se reinicia el contexto
- No se pierde información del paciente

## 📊 Estado del Dominio

```javascript
{
  // Identidad
  rutFormatted: "14348258-8",
  nombre_paciente: "Christian Inostroza",
  edad_paciente: 45,
  
  // Agendamiento
  especialidad: "Medicina General",
  fecha_solicitada: "2026-01-06",
  fecha_hora: "2026-01-06",
  hora_seleccionada: "14:30",
  doctor_box: "Dra. Vivanco - Box 4",
  
  // Control
  rutPhase: "FINALIZE",
  confirmed: true
}
```

## 🚨 Reglas Críticas

1. ❌ **NO volver a pedir RUT** - Ya validado
2. ❌ **NO reiniciar engine** - Todo en el dominio
3. ❌ **NO usar WITH_QUERY** - El dominio orquesta
4. ✅ **TODO pasa por el dominio** - Control total

## 🧪 Prueba de Aceptación

### Escenario Completo

1. Usuario dice RUT → `WAIT_BODY`
2. Bot confirma RUT → `CONFIRM`
3. Usuario dice "sí" → `VALIDATE_PATIENT` (webhook)
4. Bot pregunta especialidad → `ASK_SPECIALTY`
5. Usuario dice "medicina general" → `PARSE_SPECIALTY`
6. Bot pregunta fecha → `ASK_DATE`
7. Usuario dice "mañana" → `CHECK_AVAILABILITY` (webhook)
8. Bot informa hora → `INFORM_AVAILABILITY`
9. Usuario confirma → `CONFIRM_APPOINTMENT`
10. Bot finaliza → `FINALIZE` (webhook) → Cierre

### Logs Esperados

```
[DOMAIN] Webhook VALIDATE_PATIENT respuesta: ok=true, patientFound=true
[PARSE_SPECIALTY] Especialidad identificada: Medicina General
[ASK_DATE] Fecha identificada: TOMORROW
[CHECK_AVAILABILITY] Webhook respuesta: horaFound=true
[INFORM_AVAILABILITY] Informando: mañana dos y media
[CONFIRM_APPOINTMENT] Hora confirmada por usuario
[FINALIZE] Webhook CONFIRM_AVAILABILITY respuesta: confirmed=true
```

## ✅ Checklist Final

- [x] Todos los handlers implementados
- [x] State machine actualizado
- [x] Flujo completo sin WITH_QUERY
- [x] Webhooks integrados correctamente
- [x] Manejo de errores en cada fase
- [x] Contratos estructurados en todos los handlers
- [x] Logs explícitos para debugging
- [x] Sin dependencia de engine genérico

## 🎯 Resultado

**El dominio Quintero ahora es un orquestador completo que:**
- ✅ Valida identidad
- ✅ Consulta especialidad
- ✅ Busca disponibilidad
- ✅ Confirma cita
- ✅ Todo sin reiniciar contexto
- ✅ Todo controlado por el dominio

**Listo para producción.** 🚀

