-- ==========================================================
-- 🛠️ SCRIPT DE CORRECCIÓN DE TABLAS DE AGENTES
-- ==========================================================
-- Este script verifica y crea las tablas necesarias para el sistema de agentes

USE OmniFlows_Telephony;

-- ==========================================================
-- 1️⃣ VERIFICAR Y CREAR TABLA Agents
-- ==========================================================
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Agents' AND xtype='U')
BEGIN
    CREATE TABLE Agents (
        AgentID VARCHAR(20) PRIMARY KEY,
        Name VARCHAR(100) NOT NULL,
        Extension VARCHAR(10) NOT NULL,
        IsActive BIT DEFAULT 1,
        CreatedAt DATETIME2 DEFAULT GETDATE(),
        UpdatedAt DATETIME2 DEFAULT GETDATE()
    );
    PRINT '✅ Tabla Agents creada';
END
ELSE
    PRINT 'ℹ️ Tabla Agents ya existe';

-- ==========================================================
-- 2️⃣ VERIFICAR Y CREAR TABLA AgentStatus
-- ==========================================================
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='AgentStatus' AND xtype='U')
BEGIN
    CREATE TABLE AgentStatus (
        AgentID VARCHAR(20) PRIMARY KEY,
        Status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
        ChannelID VARCHAR(100) NULL,
        LinkedID VARCHAR(100) NULL,
        LastStatusChange DATETIME2 DEFAULT GETDATE(),
        LastUpdated DATETIME2 DEFAULT GETDATE(),
        EventSource VARCHAR(50) NULL,
        FOREIGN KEY (AgentID) REFERENCES Agents(AgentID)
    );
    PRINT '✅ Tabla AgentStatus creada';
END
ELSE
    PRINT 'ℹ️ Tabla AgentStatus ya existe';

-- ==========================================================
-- 3️⃣ INSERTAR AGENTES DE PRUEBA SI NO EXISTEN
-- ==========================================================
-- Verificar si los agentes 1001 y 1003 existen
IF NOT EXISTS (SELECT 1 FROM Agents WHERE AgentID = '1001')
BEGIN
    INSERT INTO Agents (AgentID, Name, Extension, IsActive) 
    VALUES ('1001', 'Agente 1001', '1001', 1);
    PRINT '✅ Agente 1001 creado';
END
ELSE
    PRINT 'ℹ️ Agente 1001 ya existe';

IF NOT EXISTS (SELECT 1 FROM Agents WHERE AgentID = '1003')
BEGIN
    INSERT INTO Agents (AgentID, Name, Extension, IsActive) 
    VALUES ('1003', 'Agente 1003', '1003', 1);
    PRINT '✅ Agente 1003 creado';
END
ELSE
    PRINT 'ℹ️ Agente 1003 ya existe';

-- ==========================================================
-- 4️⃣ INICIALIZAR ESTADOS DE AGENTES
-- ==========================================================
-- Crear registros en AgentStatus para agentes existentes que no tengan estado
INSERT INTO AgentStatus (AgentID, Status, LastStatusChange, LastUpdated)
SELECT a.AgentID, 'AVAILABLE', GETDATE(), GETDATE()
FROM Agents a
WHERE a.IsActive = 1 
  AND NOT EXISTS (SELECT 1 FROM AgentStatus ags WHERE ags.AgentID = a.AgentID);

PRINT '✅ Estados de agentes inicializados';

-- ==========================================================
-- 5️⃣ VERIFICAR INTEGRIDAD DE DATOS
-- ==========================================================
PRINT '🔍 Verificando integridad de datos...';

-- Mostrar agentes activos
SELECT 'Agentes Activos:' as Info;
SELECT AgentID, Name, Extension, IsActive FROM Agents WHERE IsActive = 1;

-- Mostrar estados de agentes
SELECT 'Estados de Agentes:' as Info;
SELECT ags.AgentID, a.Name, ags.Status, ags.ChannelID, ags.LastStatusChange 
FROM AgentStatus ags
JOIN Agents a ON a.AgentID = ags.AgentID
WHERE a.IsActive = 1;

-- Verificar claves foráneas
SELECT 'Verificación de Claves Foráneas:' as Info;
SELECT 
    CASE 
        WHEN EXISTS (SELECT 1 FROM AgentStatus ags LEFT JOIN Agents a ON a.AgentID = ags.AgentID WHERE a.AgentID IS NULL)
        THEN '❌ ERROR: Hay registros en AgentStatus sin agente correspondiente'
        ELSE '✅ OK: Todas las claves foráneas son válidas'
    END as FK_Status;

PRINT '✅ Script de corrección completado';
