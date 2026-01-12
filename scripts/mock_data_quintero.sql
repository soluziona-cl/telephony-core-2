-- Mock data for Quintero voicebot testing
-- Inserts sample patients, availability slots and an appointment
-- Adjust schema names/types as needed for your DB

-- Sample patients
IF NOT EXISTS (SELECT 1 FROM Patients WHERE Rut = '12.345.678-5')
BEGIN
    INSERT INTO Patients (NombreCompleto, FechaNacimiento, Rut, Telefono)
    VALUES ('Juan Pérez', '1977-06-15', '12.345.678-5', '56912345678');
END

IF NOT EXISTS (SELECT 1 FROM Patients WHERE Rut = '11.111.111-1')
BEGIN
    INSERT INTO Patients (NombreCompleto, FechaNacimiento, Rut, Telefono)
    VALUES ('María González', '1945-01-10', '11.111.111-1', '56987654321');
END

-- Availability: next few days for Cardiología and Dermatología
DECLARE @today DATE = CAST(GETDATE() AS DATE);

IF NOT EXISTS (SELECT 1 FROM Availability WHERE Especialidad = 'Cardiología' AND CAST(FechaHora AS DATE) = @today)
BEGIN
    INSERT INTO Availability (FechaHora, CuposDisponibles, Especialidad)
    VALUES (DATEADD(hour, 9, CAST(@today AS DATETIME)), 3, 'Cardiología'),
           (DATEADD(hour, 11, CAST(@today AS DATETIME)), 2, 'Cardiología');
END

IF NOT EXISTS (SELECT 1 FROM Availability WHERE Especialidad = 'Dermatología' AND CAST(FechaHora AS DATE) = DATEADD(day,1,@today))
BEGIN
    INSERT INTO Availability (FechaHora, CuposDisponibles, Especialidad)
    VALUES (DATEADD(day,1,DATEADD(hour, 10, CAST(@today AS DATETIME))), 4, 'Dermatología');
END

-- Add a future appointment for Juan Pérez (if patient exists and no appointment exists)
DECLARE @pid INT = (SELECT TOP 1 Id FROM Patients WHERE Rut = '12.345.678-5');
IF @pid IS NOT NULL
BEGIN
    IF NOT EXISTS (SELECT 1 FROM Appointments WHERE PatientId = @pid AND FechaHora > GETDATE())
    BEGIN
        INSERT INTO Appointments (PatientId, FechaHora, Especialidad, Estado, CreatedBy, CreatedAt)
        VALUES (@pid, DATEADD(day,3,DATEADD(hour,10,CAST(@today AS DATETIME))), 'Cardiología', 'CONFIRMADA', 'mock-script', GETDATE());
    END
END

PRINT 'Mock data insert script completed.';
