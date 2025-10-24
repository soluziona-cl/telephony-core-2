# 🛠️ Instrucciones de Corrección del Sistema de Telefonía

## ✅ Problemas Corregidos

### 1. **Base de Datos - Tablas Faltantes**
- ✅ Creado script SQL para crear tablas `Agents` y `AgentStatus`
- ✅ Agregada validación de existencia de agentes antes de actualizar
- ✅ Creados agentes de prueba (1001, 1003) si no existen

### 2. **Grabaciones ARI**
- ✅ Corregido `ari.recordings.record` → `ari.recordings.recordStored`
- ✅ Agregados parámetros de configuración correctos
- ✅ Manejo de errores mejorado

### 3. **Race Conditions en Limpieza**
- ✅ Mejorado sistema de locks (TTL aumentado a 30 segundos)
- ✅ Limpieza más robusta de Redis
- ✅ Validación de `linkedId` antes de limpiar

### 4. **Evento ChannelLeftBridge**
- ✅ Agregada validación del objeto canal
- ✅ Manejo de errores mejorado

### 5. **Validación de Agentes**
- ✅ Verificación de existencia antes de actualizar estado
- ✅ Logs de debug mejorados
- ✅ Fallback en caso de error de validación

## 🚀 Pasos de Implementación

### **Paso 1: Ejecutar Script SQL**
```bash
# Conectar a SQL Server y ejecutar:
sqlcmd -S tu_servidor -d OmniFlows_Telephony -i /opt/telephony-core/sql/fix_agent_tables.sql
```

### **Paso 2: Verificar Tablas Creadas**
```sql
-- Verificar que las tablas existen
SELECT name FROM sys.tables WHERE name IN ('Agents', 'AgentStatus');

-- Verificar agentes creados
SELECT * FROM Agents;
SELECT * FROM AgentStatus;
```

### **Paso 3: Reiniciar Servicios**
```bash
# Reiniciar ari-listener
pm2 restart ari-listener

# Reiniciar telephony-watcher  
pm2 restart telephony-watcher
```

### **Paso 4: Probar Sistema**
1. **Hacer llamada de prueba** desde extensión 1001 a 1003
2. **Revisar logs** para confirmar:
   - ✅ Agente detectado correctamente
   - ✅ Estado actualizado a IN_CALL
   - ✅ Al colgar, estado vuelve a AVAILABLE
   - ✅ Sin errores de base de datos

## 🔍 Logs a Monitorear

### **Logs de Éxito:**
```
🔍 Agente detectado por ANI outbound: 1001
📞 Hangup Request - Channel: PJSIP/1001-00000001, Agent: 1001, State: Up
🔴 HANGUP DEBUG - Canal: PJSIP/1001-00000001, AgentId: 1001, ANI: 1001, DNIS: 1003, Reason: hangup-request
🔄 Actualizando agente 1001 a AVAILABLE...
✅ Agente 1001 actualizado correctamente a AVAILABLE
```

### **Logs de Error a Revisar:**
```
❌ Invalid object name 'AgentStatus'
❌ The INSERT statement conflicted with the FOREIGN KEY constraint
❌ ari.recordings.record is not a function
⚠️ Agente 1001 no existe en la base de datos
```

## 🧪 Testing

### **Test 1: Llamada Interna**
```bash
# Desde extensión 1001 llamar a 1003
# Verificar que:
# - Agente 1001 se marca como IN_CALL
# - Al colgar se marca como AVAILABLE
```

### **Test 2: Llamada Externa**
```bash
# Desde extensión 1001 llamar a número externo
# Verificar detección de agente por ANI
```

### **Test 3: Múltiples Llamadas**
```bash
# Hacer varias llamadas simultáneas
# Verificar que no hay race conditions
```

## 📊 Monitoreo

### **Endpoints de Diagnóstico:**
```bash
# Estado del watcher
curl http://localhost:3005/status

# Diagnóstico de agentes
curl http://localhost:3005/diagnostics

# Lista de agentes
curl http://localhost:3005/agents

# Estado específico de agente
curl http://localhost:3005/agent-status/1001
```

### **Comandos de Limpieza:**
```bash
# Sincronizar agentes huérfanos
curl -X POST http://localhost:3005/sync-orphans

# Forzar agente a AVAILABLE
curl -X POST http://localhost:3005/agent-force-available/1001
```

## ⚠️ Notas Importantes

1. **Ejecutar el script SQL ANTES de reiniciar los servicios**
2. **Verificar que los agentes 1001 y 1003 existan en la tabla Agents**
3. **Monitorear logs durante las primeras llamadas de prueba**
4. **Si hay errores, revisar la estructura de la base de datos**

## 🆘 Troubleshooting

### **Si persisten errores de base de datos:**
```sql
-- Verificar estructura de tablas
SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME IN ('Agents', 'AgentStatus');
SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'AgentStatus';
```

### **Si no se detectan agentes:**
- Revisar formato de nombres de canal (debe ser `PJSIP/1001-xxxxx`)
- Verificar logs de detección de agente
- Comprobar que las extensiones existen en la base de datos

### **Si hay race conditions:**
- Revisar logs de locks
- Verificar TTL de locks en Redis
- Monitorear procesos de limpieza simultáneos
