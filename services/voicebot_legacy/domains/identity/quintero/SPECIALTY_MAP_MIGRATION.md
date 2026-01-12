# 🔄 Migración: Especialidad_Map desde SQL Server

## 🎯 Cambio Implementado

**El mapeo de especialidades ahora se consulta desde la tabla `Especialidad_Map` en SQL Server, en lugar de estar hardcodeado.**

## 📊 Estructura Esperada de la Tabla

```sql
CREATE TABLE Especialidad_Map (
  id INT PRIMARY KEY,
  sinonimo NVARCHAR(100),      -- Ej: "medicina general", "control", "diente"
  especialidad NVARCHAR(100),   -- Ej: "Medicina General", "Odontología"
  activo BIT DEFAULT 1
);
```

## ✅ Implementación

### 1. Nueva Función en `db-queries.js`

```javascript
export async function getSpecialtyFromMap(transcript) {
  // Consulta tabla Especialidad_Map
  // Busca coincidencias en sinónimos y especialidades
  // Retorna: { found: boolean, specialty: string|null, confidence: string }
}
```

### 2. Modificación en `parse-specialty.js`

**ANTES:**
```javascript
const SPECIALTY_MAP = {
  'medicina general': 'Medicina General',
  // ... hardcodeado
};

function classifySpecialty(transcript) {
  // Busca en mapeo local
}
```

**DESPUÉS:**
```javascript
async function classifySpecialty(transcript) {
  // 1. Consulta tabla Especialidad_Map en SQL Server
  const dbResult = await getSpecialtyFromMap(transcript);
  
  // 2. Si no encuentra, usa fallback local
  if (!dbResult.found) {
    // Busca en FALLBACK_SPECIALTY_MAP
  }
}
```

## 🔄 Flujo de Búsqueda

```
Usuario dice: "medicina general"
  ↓
1. Consulta SQL: SELECT * FROM Especialidad_Map WHERE sinonimo LIKE '%medicina general%'
  ↓
2a. Si encuentra → Retorna especialidad desde BD
  ↓
2b. Si NO encuentra → Busca en FALLBACK_SPECIALTY_MAP (local)
  ↓
3. Retorna resultado
```

## 🛡️ Fallback de Seguridad

**Si la tabla SQL no existe o hay error:**
- ✅ Usa mapeo local (`FALLBACK_SPECIALTY_MAP`)
- ✅ No rompe el flujo
- ✅ Log de advertencia para debugging

## 📋 Ventajas

1. **Dinámico**: Especialidades se pueden agregar/modificar en BD sin cambiar código
2. **Centralizado**: Un solo lugar para gestionar especialidades
3. **Escalable**: Fácil agregar nuevas especialidades y sinónimos
4. **Seguro**: Fallback local si BD no está disponible

## ✅ Checklist

- [x] Función `getSpecialtyFromMap` creada en `db-queries.js`
- [x] `parse-specialty.js` actualizado para usar consulta SQL
- [x] Fallback local mantenido para seguridad
- [x] Logs agregados para debugging
- [x] Código compilado correctamente

## 🚀 Próximos Pasos

1. Verificar que la tabla `Especialidad_Map` existe en SQL Server
2. Verificar estructura de columnas (`sinonimo`, `especialidad`)
3. Probar con una llamada real
4. Si la estructura es diferente, ajustar la query en `getSpecialtyFromMap`

