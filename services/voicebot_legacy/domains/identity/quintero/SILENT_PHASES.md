# 🔇 Fases Silenciosas - Quintero

## 🎯 Concepto

**Fases silenciosas** son fases del dominio donde el bot NO debe esperar voz del usuario. El sistema ejecuta acciones automáticamente (webhooks, TTS) y avanza al siguiente paso.

## 📋 Fases Silenciosas en Quintero

| Fase | Propósito | skipUserInput |
|------|-----------|---------------|
| `CHECK_AVAILABILITY` | Consultar webhook de disponibilidad | ✅ `true` |
| `INFORM_AVAILABILITY` | Informar hora encontrada | ✅ `true` |
| `FINALIZE` | Confirmar cita y cerrar | ✅ `true` |

## 🔧 Implementación

### En el Handler

Cada handler de fase silenciosa devuelve:

```javascript
return {
  ttsText: "Mensaje a reproducir",
  nextPhase: 'SIGUIENTE_FASE',
  skipUserInput: true, // ← Indica fase silenciosa
  action: { ... }
};
```

### En el Engine

El engine lee `skipUserInput` del contrato del dominio:

```javascript
if (logicResult.skipUserInput === true) {
  // NO esperar voz
  // Ejecutar dominio inmediatamente
  // Reproducir TTS
  // Avanzar automáticamente
}
```

## ✅ Ventajas

1. **Genérico**: Cualquier dominio puede usar `skipUserInput`
2. **Aislado**: Lógica de Quintero NO afecta otros bots
3. **Escalable**: Fácil agregar nuevas fases silenciosas
4. **Mantenible**: Cambios en Quintero NO requieren modificar engine

## 🚫 NO Hacer

❌ Hardcodear fases silenciosas en el engine
❌ Agregar lógica específica de Quintero al engine
❌ Asumir que todas las fases silenciosas son iguales

## ✅ Hacer

✅ Definir fases silenciosas en el dominio
✅ Devolver `skipUserInput: true` en handlers
✅ Dejar que el engine lea el contrato genéricamente

