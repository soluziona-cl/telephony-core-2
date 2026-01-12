// /services/business-rules.js
import { sql, poolPromise } from "../../../lib/db.js";
import { log } from "../../../lib/logger.js";

/**
 * Obtiene las reglas activas desde SQL Server
 */
export async function getActiveRules(tenantId = 1) {
    try {
        const pool = await poolPromise;
        const result = await pool
            .request()
            .input("TenantId", sql.Int, tenantId)
            .execute("usp_BusinessRules_GetActive");
        return result.recordset;
    } catch (err) {
        log("error", "Error al obtener reglas activas", err.message);
        return [];
    }
}

/**
 * Evalúa una regla por tipo
 * @param {string} type - Tipo de regla ('schedule','vip','holiday')
 * @param {string} [value] - Valor a evaluar (ej. número del cliente)
 */
export async function checkRule(type, value = "") {
    const rules = await getActiveRules(1);
    const match = rules.find((r) => r.RuleType === type && r.IsActive);

    if (!match) return true; // si no existe regla, permitir flujo normal

    switch (type) {
        case "schedule":
            return isWithinSchedule(match.Param1, match.Param2);

        case "vip":
            return match.Param1?.split(",").includes(value);

        case "holiday":
            return !isHolidayToday(match.Param1);

        default:
            return true;
    }
}

/** Horario dentro del rango permitido */
function isWithinSchedule(start = "09:00", end = "18:00") {
    const now = new Date();
    const [h1, m1] = start.split(":").map(Number);
    const [h2, m2] = end.split(":").map(Number);

    const startTime = new Date();
    startTime.setHours(h1, m1, 0, 0);

    const endTime = new Date();
    endTime.setHours(h2, m2, 0, 0);

    return now >= startTime && now <= endTime;
}

/** Verifica si hoy es feriado (MM-DD) */
function isHolidayToday(list = "") {
    const today = new Date().toISOString().slice(5, 10); // 'MM-DD'
    return list.split(",").includes(today);
}
