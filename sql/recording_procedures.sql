-- ==========================================================
-- PROCEDIMIENTOS ALMACENADOS PARA GRABACIONES
-- ==========================================================
-- Estos SPs permiten actualizar RecordingPath en ActiveCalls y CallLogs
-- cuando el telephony-watcher recibe eventos call.hangup con recordingPath

-- ==========================================================
-- 1️⃣ Actualiza ruta de grabación en ActiveCalls
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_ActiveCalls_UpdateRecordingPath
  @ChannelId VARCHAR(64),
  @RecordingPath NVARCHAR(1024)
AS
BEGIN
  SET NOCOUNT ON;
  
  UPDATE dbo.ActiveCalls
  SET RecordingPath = @RecordingPath
  WHERE ChannelId = @ChannelId;
  
  -- Log para debugging
  IF @@ROWCOUNT > 0
    PRINT 'RecordingPath actualizado en ActiveCalls para ChannelId: ' + @ChannelId;
  ELSE
    PRINT 'No se encontró registro en ActiveCalls para ChannelId: ' + @ChannelId;
END
GO

-- ==========================================================
-- 2️⃣ Actualiza ruta de grabación en CallLogs
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_CallLogs_UpdateRecordingPath
  @ChannelId VARCHAR(64),
  @RecordingPath NVARCHAR(1024)
AS
BEGIN
  SET NOCOUNT ON;
  
  UPDATE dbo.CallLogs
  SET RecordingPath = @RecordingPath
  WHERE ChannelId = @ChannelId;
  
  -- Log para debugging
  IF @@ROWCOUNT > 0
    PRINT 'RecordingPath actualizado en CallLogs para ChannelId: ' + @ChannelId;
  ELSE
    PRINT 'No se encontró registro en CallLogs para ChannelId: ' + @ChannelId;
END
GO

-- ==========================================================
-- 3️⃣ SP adicional: Obtener grabaciones por fecha
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_GetRecordingsByDate
  @StartDate DATE,
  @EndDate DATE
AS
BEGIN
  SET NOCOUNT ON;
  
  SELECT 
    cl.ChannelId,
    cl.LinkedId,
    cl.Ani,
    cl.Dnis,
    cl.Direction,
    cl.StartedAt,
    cl.EndedAt,
    cl.Reason,
    cl.RecordingPath,
    CASE 
      WHEN cl.RecordingPath IS NOT NULL THEN 'Available'
      ELSE 'Not Available'
    END AS RecordingStatus
  FROM dbo.CallLogs cl
  WHERE cl.StartedAt >= @StartDate 
    AND cl.StartedAt < DATEADD(day, 1, @EndDate)
    AND cl.RecordingPath IS NOT NULL
  ORDER BY cl.StartedAt DESC;
END
GO

-- ==========================================================
-- 4️⃣ SP adicional: Limpiar grabaciones antiguas (opcional)
-- ==========================================================
CREATE OR ALTER PROCEDURE usp_CleanupOldRecordings
  @DaysToKeep INT = 30
AS
BEGIN
  SET NOCOUNT ON;
  
  DECLARE @CutoffDate DATE = DATEADD(day, -@DaysToKeep, GETDATE());
  
  -- Marcar grabaciones como archivadas (no eliminar físicamente)
  UPDATE dbo.CallLogs
  SET RecordingPath = NULL
  WHERE StartedAt < @CutoffDate 
    AND RecordingPath IS NOT NULL;
    
  PRINT 'Grabaciones anteriores a ' + CAST(@CutoffDate AS VARCHAR(10)) + ' marcadas como archivadas';
END
GO

-- ==========================================================
-- VERIFICACIÓN DE TABLAS REQUERIDAS
-- ==========================================================
-- Asegúrate de que las tablas tengan la columna RecordingPath:

-- Para ActiveCalls:
-- ALTER TABLE dbo.ActiveCalls ADD RecordingPath NVARCHAR(1024) NULL;

-- Para CallLogs:
-- ALTER TABLE dbo.CallLogs ADD RecordingPath NVARCHAR(1024) NULL;

PRINT 'Procedimientos almacenados para grabaciones creados exitosamente';
