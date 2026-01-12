# 🚀 Guía de Migración a Arquitectura de Dominios

## ✅ Implementación Completada

Se ha implementado la arquitectura de dominios para el sistema de voicebot, separando la lógica de negocio por dominio y permitiendo escalabilidad sin afectar otros bots.

## 📁 Estructura Creada

```
services/voicebot/
├── domains/
│   ├── identity/              # Identificación y validación
│   │   ├── quintero/          # Bot Quintero (completo)
│   │   │   ├── handlers/      # wait-body, wait-dv, confirm
│   │   │   ├── rut/           # Parser, validator, normalizer
│   │   │   ├── tts/           # Mensajes TTS
│   │   │   └── prompts/       # Prompts LLM
│   │   └── default/           # Bot por defecto
│   ├── service/               # Atención general
│   ├── sales/                 # Ventas
│   └── collections/           # Cobranza
├── router/
│   └── voicebot-domain-router.js
└── shared/
    └── confirm-classifier.js  # Clasificador de confirmación
```

## 🔀 Cómo Funciona

### Router de Dominios

El router analiza el `mode` de la llamada y enruta al dominio correspondiente:

- `voicebot_identity_quintero` → Dominio Identity, Bot Quintero
- `voicebot_service_soporte` → Dominio Service, Bot Soporte
- `voicebot_sales_ventas` → Dominio Sales, Bot Ventas
- `voicebot_collections_cobranza` → Dominio Collections, Bot Cobranza

### Feature Flag

El routing por dominios está controlado por una variable de entorno:

```bash
USE_DOMAIN_ROUTING=true  # Habilita routing por dominios
USE_DOMAIN_ROUTING=false # Usa modo tradicional (default)
```

## 🎯 Bot Quintero (Implementado)

### Características

✅ State machine completa (WAIT_BODY → WAIT_DV → CONFIRM → COMPLETE)  
✅ Parser de RUT desde voz (soporta millones, miles, DV hablado)  
✅ Validación matemática del dígito verificador  
✅ Confirmación con aceptación implícita  
✅ Búsqueda de paciente en BD  
✅ Mensajes TTS optimizados para adultos mayores  
✅ Manejo de errores y escalamiento  

### Estados

- **WAIT_BODY**: Espera RUT completo
- **WAIT_DV**: Espera solo dígito verificador
- **CONFIRM**: Confirma RUT detectado
- **COMPLETE**: RUT validado exitosamente
- **FAILED**: Error en captura/validación

## 📝 Uso

### Activar Bot Quintero con Dominios

1. Configurar variable de entorno:
   ```bash
   export USE_DOMAIN_ROUTING=true
   ```

2. Usar modo con formato de dominio:
   ```
   voicebot_identity_quintero
   ```

3. El handler detectará automáticamente y usará el dominio.

### Modo Legacy (Sin Cambios)

El modo `voicebot_quintero` sigue funcionando igual que antes, sin usar dominios.

## 🔧 Integración con Engine

El engine actual (`voicebot-engine-inbound-v3.js`) sigue funcionando igual. El dominio se pasa como parámetro opcional y puede ser usado cuando el engine lo necesite.

**Nota**: La integración completa del dominio con el engine requiere modificaciones adicionales en el engine para que use el dominio en lugar de la lógica hardcodeada. Esto se puede hacer en una fase posterior.

## ✅ Beneficios Inmediatos

1. **Aislamiento**: Cambios en Quintero no afectan otros bots
2. **Escalabilidad**: Fácil agregar nuevos bots por dominio
3. **Mantenibilidad**: Código organizado y claro
4. **Testing**: Cada dominio puede testearse independientemente
5. **Documentación**: README por dominio explica reglas y uso

## 🚦 Próximos Pasos

1. **Fase 2**: Integrar dominio Quintero completamente en el engine
2. **Fase 3**: Migrar otros bots a sus dominios correspondientes
3. **Fase 4**: Eliminar lógica hardcodeada del engine
4. **Fase 5**: Implementar tests unitarios por dominio

## 📚 Documentación

- [Identity Domain README](./identity/README.md)
- [Quintero Bot README](./identity/quintero/README.md)
- [Service Domain README](./service/README.md)
- [Sales Domain README](./sales/README.md)
- [Collections Domain README](./collections/README.md)

## ⚠️ Notas Importantes

1. **No rompe producción**: El modo legacy sigue funcionando
2. **Feature flag**: El routing por dominios es opcional
3. **Compatibilidad**: El código existente sigue funcionando
4. **Migración gradual**: Se puede migrar bot por bot

## 🐛 Troubleshooting

### El bot no usa el dominio

- Verificar que `USE_DOMAIN_ROUTING=true`
- Verificar que el modo tenga formato `voicebot_{domain}_{bot}`
- Revisar logs para ver qué dominio se resolvió

### Error en importación

- Verificar que todos los archivos estén en su lugar
- Verificar imports relativos correctos
- Revisar logs de Node.js para errores de módulo

