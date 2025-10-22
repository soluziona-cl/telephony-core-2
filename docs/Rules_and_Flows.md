# Reglas de Negocio — Telephony Core

## Tipos de reglas
| Tipo | Descripción | Ejemplo |
|------|--------------|----------|
| schedule | Control de horario laboral | 09:00-18:00 |
| vip | Números con atención prioritaria | 1001,1002,1005 |
| holiday | Fechas feriadas (MM-DD) | 01-01,09-18,12-25 |

## Flujo de aplicación
1. ari-listener detecta `stasis_start`
2. Ejecuta `checkRule("schedule")`
3. Si fuera de horario → IVR AfterHours
4. Si cliente VIP → IVR VIP
5. Caso contrario → flujo normal

## Eventos Redis
- `rule.applied` → `{ type: "vip" | "afterhours" }`