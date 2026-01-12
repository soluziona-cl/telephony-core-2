# 📊 Estructura Real: Especialidad_Map

## 🗄️ Tabla SQL Server

```sql
CREATE TABLE [dbo].[Especialidad_Map](
    [id] [int] IDENTITY(1,1) NOT NULL,
    [especialidad_input] [varchar](100) NOT NULL,      -- Sinónimo/palabra clave
    [especialidad_canonica] [varchar](100) NOT NULL,   -- Especialidad canónica
    [activo] [bit] NULL DEFAULT 1,
    PRIMARY KEY CLUSTERED ([id] ASC)
)
```

## 📋 Columnas

| Columna | Tipo | Descripción | Ejemplo |
|---------|------|-------------|---------|
| `id` | `int` | ID autoincremental | `1` |
| `especialidad_input` | `varchar(100)` | Sinónimo o palabra clave del usuario | `"medicina general"`, `"control"`, `"diente"` |
| `especialidad_canonica` | `varchar(100)` | Nombre canónico de la especialidad | `"Medicina General"`, `"Odontología"` |
| `activo` | `bit` | Flag para habilitar/deshabilitar | `1` (activo), `0` (inactivo) |

## 🔍 Query Implementada

```sql
SELECT TOP 1 
  especialidad_canonica,
  especialidad_input
FROM Especialidad_Map
WHERE activo = 1
  AND (
    LOWER(especialidad_input) = LOWER(@text)           -- Coincidencia exacta
    OR LOWER(especialidad_input) LIKE @textLike        -- Coincidencia parcial
    OR LOWER(especialidad_canonica) LIKE @textLike    -- Coincidencia en canónica
  )
ORDER BY 
  -- Priorizar coincidencias exactas
  CASE 
    WHEN LOWER(especialidad_input) = LOWER(@text) THEN 1
    WHEN LOWER(especialidad_canonica) = LOWER(@text) THEN 2
    ELSE 3
  END,
  -- Luego por longitud (más corto = más específico)
  LEN(especialidad_input) ASC
```

## ✅ Características

1. **Filtro por activo**: Solo busca registros con `activo = 1`
2. **Coincidencia exacta primero**: Prioriza coincidencias exactas sobre parciales
3. **Búsqueda flexible**: Busca en `especialidad_input` y `especialidad_canonica`
4. **Ordenamiento inteligente**: Ordena por exactitud y luego por longitud

## 📝 Ejemplos de Datos

```sql
INSERT INTO Especialidad_Map (especialidad_input, especialidad_canonica, activo)
VALUES 
  ('medicina general', 'Medicina General', 1),
  ('medicina', 'Medicina General', 1),
  ('control', 'Medicina General', 1),
  ('consulta', 'Medicina General', 1),
  ('dental', 'Odontología', 1),
  ('odontología', 'Odontología', 1),
  ('diente', 'Odontología', 1),
  ('muela', 'Odontología', 1);
```

## 🎯 Uso en el Código

```javascript
// En parse-specialty.js
const classification = await classifySpecialty(transcript);

// classifySpecialty() internamente llama:
const dbResult = await getSpecialtyFromMap(transcript);

// getSpecialtyFromMap() consulta Especialidad_Map y retorna:
{
  found: true,
  specialty: "Medicina General",  // desde especialidad_canonica
  confidence: "high"               // "high" si coincidencia exacta, "medium" si parcial
}
```

## ✅ Ventajas

- ✅ **Dinámico**: Especialidades se gestionan desde BD
- ✅ **Flexible**: Múltiples sinónimos por especialidad
- ✅ **Activable/Desactivable**: Campo `activo` para control
- ✅ **Fallback seguro**: Si BD falla, usa mapeo local

