#!/bin/bash
PHASE=${1:-1}

CONFIG_FILE="/opt/telephony-core/services/client/quintero/config/phases.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Error: Config file not found at $CONFIG_FILE"
    exit 1
fi

echo "🔄 Changing to FASE $PHASE..."

# Actualizar configuración usando sed para evitar dependencia de jq (aunque recomendado)
sed -i "s/\"current_phase\": [0-9]/\"current_phase\": $PHASE/" "$CONFIG_FILE"

# Verificar si el cambio fue exitoso (simple grep check)
if grep -q "\"current_phase\": $PHASE" "$CONFIG_FILE"; then
    echo "✅ Configuration updated to Phase $PHASE."
else
    echo "❌ Failed to update configuration."
    exit 1
fi

# Reiniciar servicio
echo "🔄 Restarting telephony-core service..."
systemctl restart telephony-core

echo "🚀 FASE $PHASE activated and service restarted."
