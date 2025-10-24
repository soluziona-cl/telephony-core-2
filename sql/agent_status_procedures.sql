-- ==========================================================
-- PROCEDIMIENTOS ALMACENADOS PARA AGENT STATUS
-- ==========================================================
-- Estos SPs permiten gestionar el estado de los agentes
-- y verificar estados después de actualizaciones

-- ==========================================================
-- 1️⃣ Obtener estado de agente por extensión
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_AgentStatus_GetByExtension
    @Extension VARCHAR(10)
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        AgentId,
        Extension, 
        Status,
        ChannelId,
        LastStatusChange,
        UpdatedAt
    FROM AgentStatus 
    WHERE Extension = @Extension;
END
GO

-- ==========================================================
-- 2️⃣ Sincronizar estado de agente por extensión (PRINCIPAL)
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_AgentStatus_SyncByExtension
    @Extension VARCHAR(10),
    @NewStatus VARCHAR(20),
    @Event VARCHAR(50),
    @ChannelId VARCHAR(64) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Insertar o actualizar el estado del agente
    MERGE AgentStatus AS target
    USING (SELECT @Extension as Extension, @NewStatus as Status, @ChannelId as ChannelId, GETDATE() as UpdatedAt) AS source
    ON target.Extension = source.Extension
    WHEN MATCHED THEN
        UPDATE SET 
            Status = source.Status,
            ChannelId = source.ChannelId,
            LastStatusChange = GETDATE(),
            UpdatedAt = source.UpdatedAt
    WHEN NOT MATCHED THEN
        INSERT (Extension, Status, ChannelId, LastStatusChange, UpdatedAt)
        VALUES (source.Extension, source.Status, source.ChannelId, source.UpdatedAt, source.UpdatedAt);
    
    -- Log del evento
    PRINT 'Agente ' + @Extension + ' sincronizado a ' + @NewStatus + ' (Evento: ' + @Event + ')';
END
GO

-- ==========================================================
-- 3️⃣ Actualizar estado de agente por extensión
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_AgentStatus_UpdateByExtension
    @Extension VARCHAR(10),
    @NewStatus VARCHAR(20),
    @ChannelId VARCHAR(64) = NULL,
    @EventSource VARCHAR(50) = 'manual'
AS
BEGIN
    SET NOCOUNT ON;
    
    UPDATE AgentStatus 
    SET Status = @NewStatus,
        ChannelId = @ChannelId,
        LastStatusChange = GETDATE(),
        UpdatedAt = GETDATE()
    WHERE Extension = @Extension;
    
    -- Si no existe, crear el registro
    IF @@ROWCOUNT = 0
    BEGIN
        INSERT INTO AgentStatus (Extension, Status, ChannelId, LastStatusChange, UpdatedAt)
        VALUES (@Extension, @NewStatus, @ChannelId, GETDATE(), GETDATE());
    END
    
    PRINT 'Agente ' + @Extension + ' actualizado a ' + @NewStatus + ' (Fuente: ' + @EventSource + ')';
END
GO

-- ==========================================================
-- 4️⃣ Sincronizar estado en hangup
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_AgentStatus_SyncOnHangup
    @ChannelId VARCHAR(64),
    @NewStatus VARCHAR(20),
    @AgentExtension VARCHAR(10)
AS
BEGIN
    SET NOCOUNT ON;
    
    UPDATE AgentStatus 
    SET Status = @NewStatus,
        ChannelId = NULL,
        LastStatusChange = GETDATE(),
        UpdatedAt = GETDATE()
    WHERE Extension = @AgentExtension;
    
    PRINT 'Agente ' + @AgentExtension + ' sincronizado a ' + @NewStatus + ' en hangup del canal ' + @ChannelId;
END
GO

-- ==========================================================
-- 5️⃣ Obtener todos los agentes (para endpoint /agents)
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_AgentStatus_GetAll
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        AgentId,
        Extension, 
        Status,
        ChannelId,
        LastStatusChange,
        UpdatedAt
    FROM AgentStatus 
    ORDER BY Extension;
END
GO

-- ==========================================================
-- 3️⃣ Reporte de diagnóstico de agentes
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_AgentStatus_DiagnosticReport
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Reporte de agentes por estado
    SELECT 
        Status,
        COUNT(*) as Count,
        STRING_AGG(Extension, ', ') as Extensions
    FROM AgentStatus 
    GROUP BY Status
    ORDER BY Status;
    
    -- Resumen general
    SELECT 
        COUNT(*) as TotalAgents,
        COUNT(CASE WHEN Status = 'AVAILABLE' THEN 1 END) as AvailableAgents,
        COUNT(CASE WHEN Status = 'IN_CALL' THEN 1 END) as InCallAgents,
        COUNT(CASE WHEN Status = 'RINGING' THEN 1 END) as RingingAgents,
        COUNT(CASE WHEN Status = 'UNAVAILABLE' THEN 1 END) as UnavailableAgents
    FROM AgentStatus;
END
GO

-- ==========================================================
-- 4️⃣ Sincronización de agentes huérfanos
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_AgentStatus_SyncOrphans
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Marcar como disponibles agentes que están en estado de llamada
    -- pero no tienen canal activo asociado
    UPDATE AgentStatus 
    SET Status = 'AVAILABLE',
        ChannelId = NULL,
        UpdatedAt = GETDATE()
    WHERE Status IN ('IN_CALL', 'RINGING') 
      AND (ChannelId IS NULL OR ChannelId = '');
    
    -- Log de agentes sincronizados
    SELECT @@ROWCOUNT as OrphanedAgentsSynced;
END
GO

-- ==========================================================
-- 5️⃣ Limpieza de agentes huérfanos por LinkedId
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_AgentStatus_CleanupOrphaned
    @LinkedId VARCHAR(64)
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Buscar agentes que podrían estar asociados a este LinkedId
    -- y marcarlos como disponibles si no tienen canal activo
    UPDATE AgentStatus 
    SET Status = 'AVAILABLE',
        ChannelId = NULL,
        UpdatedAt = GETDATE()
    WHERE Status IN ('IN_CALL', 'RINGING') 
      AND (ChannelId IS NULL OR ChannelId = '');
    
    -- Log de limpieza
    SELECT @@ROWCOUNT as CleanedAgents;
END
GO

-- ==========================================================
-- 6️⃣ Forzar agente a disponible (endpoint /agent-force-available)
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_AgentStatus_ForceAvailable
    @Extension VARCHAR(10)
AS
BEGIN
    SET NOCOUNT ON;
    
    UPDATE AgentStatus 
    SET Status = 'AVAILABLE',
        ChannelId = NULL,
        UpdatedAt = GETDATE()
    WHERE Extension = @Extension;
    
    -- Log de forzado
    IF @@ROWCOUNT > 0
        PRINT 'Agente ' + @Extension + ' forzado a AVAILABLE';
    ELSE
        PRINT 'No se encontró agente con extensión ' + @Extension;
END
GO

-- ==========================================================
-- PROCEDIMIENTOS ADICIONALES PARA ACTIVE CALLS
-- ==========================================================

-- ==========================================================
-- 6️⃣ Upsert en ActiveCalls (usado en call.state)
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_ActiveCalls_Upsert
    @ChannelId VARCHAR(64),
    @LinkedId VARCHAR(64),
    @Direction VARCHAR(10),
    @Ani VARCHAR(32),
    @Dnis VARCHAR(32),
    @State VARCHAR(20),
    @Reason VARCHAR(40),
    @QueueId INT = NULL,
    @AgentId INT = NULL,
    @RecordingPath NVARCHAR(1024) = NULL,
    @StartedAt DATETIME2 = NULL
AS
BEGIN
    SET NOCOUNT ON;
    
    MERGE ActiveCalls AS target
    USING (SELECT @ChannelId as ChannelId, @LinkedId as LinkedId, @Direction as Direction, 
                  @Ani as Ani, @Dnis as Dnis, @State as State, @Reason as Reason,
                  @QueueId as QueueId, @AgentId as AgentId, @RecordingPath as RecordingPath,
                  @StartedAt as StartedAt) AS source
    ON target.ChannelId = source.ChannelId
    WHEN MATCHED THEN
        UPDATE SET 
            LinkedId = source.LinkedId,
            Direction = source.Direction,
            Ani = source.Ani,
            Dnis = source.Dnis,
            State = source.State,
            Reason = source.Reason,
            QueueId = source.QueueId,
            AgentId = source.AgentId,
            RecordingPath = source.RecordingPath,
            StartedAt = ISNULL(source.StartedAt, target.StartedAt),
            UpdatedAt = GETDATE()
    WHEN NOT MATCHED THEN
        INSERT (ChannelId, LinkedId, Direction, Ani, Dnis, State, Reason, QueueId, AgentId, RecordingPath, StartedAt, CreatedAt, UpdatedAt)
        VALUES (source.ChannelId, source.LinkedId, source.Direction, source.Ani, source.Dnis, 
                source.State, source.Reason, source.QueueId, source.AgentId, source.RecordingPath, 
                source.StartedAt, GETDATE(), GETDATE());
END
GO

-- ==========================================================
-- 7️⃣ Insertar desde ActiveCalls a CallLogs
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_CallLogs_InsertFromActive
    @ChannelId VARCHAR(64),
    @Status VARCHAR(32)
AS
BEGIN
    SET NOCOUNT ON;
    
    INSERT INTO CallLogs (ChannelId, LinkedId, Direction, Ani, Dnis, State, Reason, QueueId, AgentId, RecordingPath, StartedAt, EndedAt, Status)
    SELECT ChannelId, LinkedId, Direction, Ani, Dnis, State, Reason, QueueId, AgentId, RecordingPath, StartedAt, GETDATE(), @Status
    FROM ActiveCalls 
    WHERE ChannelId = @ChannelId;
    
    -- Eliminar de ActiveCalls después de insertar en CallLogs
    DELETE FROM ActiveCalls WHERE ChannelId = @ChannelId;
END
GO

-- ==========================================================
-- 8️⃣ Actualizar ruta de grabación en ActiveCalls
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_ActiveCalls_UpdateRecordingPath
    @ChannelId VARCHAR(64),
    @RecordingPath NVARCHAR(1024)
AS
BEGIN
    SET NOCOUNT ON;
    
    UPDATE ActiveCalls
    SET RecordingPath = @RecordingPath,
        UpdatedAt = GETDATE()
    WHERE ChannelId = @ChannelId;
END
GO

-- ==========================================================
-- 9️⃣ Actualizar ruta de grabación en CallLogs
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_CallLogs_UpdateRecordingPath
    @ChannelId VARCHAR(64),
    @RecordingPath NVARCHAR(1024)
AS
BEGIN
    SET NOCOUNT ON;
    
    UPDATE CallLogs
    SET RecordingPath = @RecordingPath,
        UpdatedAt = GETDATE()
    WHERE ChannelId = @ChannelId;
END
GO

-- ==========================================================
-- PROCEDIMIENTOS ADICIONALES PARA AGENTES
-- ==========================================================

-- ==========================================================
-- 10️⃣ Establecer estado de login del agente
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_Agent_SetLoginStatus
    @Extension VARCHAR(10),
    @IsLoggedIn BIT
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Actualizar o insertar estado de login
    MERGE AgentLoginStatus AS target
    USING (SELECT @Extension as Extension, @IsLoggedIn as IsLoggedIn, GETDATE() as UpdatedAt) AS source
    ON target.Extension = source.Extension
    WHEN MATCHED THEN
        UPDATE SET 
            IsLoggedIn = source.IsLoggedIn,
            UpdatedAt = source.UpdatedAt
    WHEN NOT MATCHED THEN
        INSERT (Extension, IsLoggedIn, UpdatedAt)
        VALUES (source.Extension, source.IsLoggedIn, source.UpdatedAt);
END
GO

-- ==========================================================
-- VERIFICACIÓN DE TABLAS REQUERIDAS
-- ==========================================================
-- Asegúrate de que las tablas existen con estas columnas:

/*
-- Tabla AgentStatus:
CREATE TABLE AgentStatus (
    AgentId INT IDENTITY(1,1) PRIMARY KEY,
    Extension VARCHAR(10) NOT NULL UNIQUE,
    Status VARCHAR(20) NOT NULL DEFAULT 'UNAVAILABLE',
    ChannelId VARCHAR(64) NULL,
    LastStatusChange DATETIME2 DEFAULT GETDATE(),
    UpdatedAt DATETIME2 DEFAULT GETDATE()
);

-- Tabla ActiveCalls:
CREATE TABLE ActiveCalls (
    ChannelId VARCHAR(64) PRIMARY KEY,
    LinkedId VARCHAR(64) NOT NULL,
    Direction VARCHAR(10) NOT NULL,
    Ani VARCHAR(32) NULL,
    Dnis VARCHAR(32) NULL,
    State VARCHAR(20) NOT NULL,
    Reason VARCHAR(40) NULL,
    QueueId INT NULL,
    AgentId INT NULL,
    RecordingPath NVARCHAR(1024) NULL,
    StartedAt DATETIME2 NULL,
    CreatedAt DATETIME2 DEFAULT GETDATE(),
    UpdatedAt DATETIME2 DEFAULT GETDATE()
);

-- Tabla CallLogs:
CREATE TABLE CallLogs (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    ChannelId VARCHAR(64) NOT NULL,
    LinkedId VARCHAR(64) NOT NULL,
    Direction VARCHAR(10) NOT NULL,
    Ani VARCHAR(32) NULL,
    Dnis VARCHAR(32) NULL,
    State VARCHAR(20) NOT NULL,
    Reason VARCHAR(40) NULL,
    QueueId INT NULL,
    AgentId INT NULL,
    RecordingPath NVARCHAR(1024) NULL,
    StartedAt DATETIME2 NULL,
    EndedAt DATETIME2 NULL,
    Status VARCHAR(32) NULL,
    CreatedAt DATETIME2 DEFAULT GETDATE(),
    UpdatedAt DATETIME2 DEFAULT GETDATE()
);

-- Tabla AgentLoginStatus:
CREATE TABLE AgentLoginStatus (
    Extension VARCHAR(10) PRIMARY KEY,
    IsLoggedIn BIT NOT NULL DEFAULT 0,
    UpdatedAt DATETIME2 DEFAULT GETDATE()
);
*/

PRINT 'Procedimientos almacenados para AgentStatus y ActiveCalls creados exitosamente';
