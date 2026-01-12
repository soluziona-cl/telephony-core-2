#!/bin/bash

###############################################################################
# 🚀 Script de Instalación - Telephony Core Service
# Instala y configura el servicio systemd
###############################################################################

set -e  # Salir si hay error

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Variables
SERVICE_NAME="telephony-core"
INSTALL_DIR="/opt/telephony-core"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
USER="asterisk"
GROUP="asterisk"

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════╗"
echo "║                                           ║"
echo "║      📞 TELEPHONY CORE INSTALLER          ║"
echo "║                                           ║"
echo "╚═══════════════════════════════════════════╝"
echo -e "${NC}"

# Verificar si se ejecuta como root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Este script debe ejecutarse como root${NC}"
    echo "   Usa: sudo $0"
    exit 1
fi

echo -e "${YELLOW}📋 Verificando requisitos...${NC}"

# Verificar Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js no está instalado${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Node.js $(node --version)${NC}"

# Verificar npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm no está instalado${NC}"
    exit 1
fi
echo -e "${GREEN}✅ npm $(npm --version)${NC}"

# Verificar ffmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo -e "${YELLOW}⚠️  ffmpeg no está instalado (necesario para conversión de audio)${NC}"
    read -p "¿Deseas instalarlo ahora? (s/n): " install_ffmpeg
    if [[ $install_ffmpeg == "s" || $install_ffmpeg == "S" ]]; then
        echo -e "${BLUE}📦 Instalando ffmpeg...${NC}"
        apt-get update && apt-get install -y ffmpeg
        echo -e "${GREEN}✅ ffmpeg instalado${NC}"
    fi
fi

# Verificar usuario asterisk
if ! id -u "$USER" &>/dev/null; then
    echo -e "${YELLOW}⚠️  Usuario 'asterisk' no existe${NC}"
    read -p "¿Deseas crearlo? (s/n): " create_user
    if [[ $create_user == "s" || $create_user == "S" ]]; then
        useradd -r -s /bin/false asterisk
        echo -e "${GREEN}✅ Usuario 'asterisk' creado${NC}"
    else
        echo -e "${RED}❌ No se puede continuar sin el usuario${NC}"
        exit 1
    fi
fi

echo ""
echo -e "${BLUE}📁 Verificando directorio de instalación...${NC}"

if [ ! -d "$INSTALL_DIR" ]; then
    echo -e "${RED}❌ El directorio $INSTALL_DIR no existe${NC}"
    echo "   Por favor, copia tu proyecto a $INSTALL_DIR primero"
    exit 1
fi

cd "$INSTALL_DIR"
echo -e "${GREEN}✅ Directorio encontrado: $INSTALL_DIR${NC}"

# Verificar package.json
if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ No se encontró package.json en $INSTALL_DIR${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}📦 Instalando dependencias de Node.js...${NC}"
npm install --production
echo -e "${GREEN}✅ Dependencias instaladas${NC}"

echo ""
echo -e "${BLUE}🔐 Configurando permisos...${NC}"
chown -R $USER:$GROUP "$INSTALL_DIR"
chmod 755 "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/.env" 2>/dev/null || true
echo -e "${GREEN}✅ Permisos configurados${NC}"

echo ""
echo -e "${BLUE}📝 Creando archivo de servicio systemd...${NC}"

cat > "$SERVICE_FILE" << 'EOF'
[Unit]
Description=Telephony Core - Asterisk ARI Integration Service
Documentation=https://github.com/your-org/telephony-core
After=network.target asterisk.service redis.service
Wants=asterisk.service redis.service

[Service]
Type=simple
User=asterisk
Group=asterisk
WorkingDirectory=/opt/telephony-core

# Variables de entorno
Environment=NODE_ENV=production
EnvironmentFile=/opt/telephony-core/.env

# Comando principal - CAMBIA ESTO según tu punto de entrada
ExecStart=/usr/bin/node /opt/telephony-core/index.js

# Reinicio automático
Restart=always
RestartSec=10
StartLimitInterval=60
StartLimitBurst=3

# Logs
StandardOutput=journal
StandardError=journal
SyslogIdentifier=telephony-core

# Límites de recursos
LimitNOFILE=65536
LimitNPROC=4096

# Seguridad
NoNewPrivileges=true
PrivateTmp=true

# Timeouts
TimeoutStartSec=30
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}✅ Archivo de servicio creado: $SERVICE_FILE${NC}"

echo ""
echo -e "${BLUE}🔄 Recargando systemd...${NC}"
systemctl daemon-reload
echo -e "${GREEN}✅ systemd recargado${NC}"

echo ""
echo -e "${BLUE}⚙️  Habilitando servicio...${NC}"
systemctl enable $SERVICE_NAME
echo -e "${GREEN}✅ Servicio habilitado para inicio automático${NC}"

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                           ║${NC}"
echo -e "${GREEN}║     ✅ INSTALACIÓN COMPLETADA             ║${NC}"
echo -e "${GREEN}║                                           ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════╝${NC}"

echo ""
echo -e "${YELLOW}📋 Comandos útiles:${NC}"
echo ""
echo -e "  ${BLUE}# Iniciar servicio${NC}"
echo "  sudo systemctl start $SERVICE_NAME"
echo ""
echo -e "  ${BLUE}# Detener servicio${NC}"
echo "  sudo systemctl stop $SERVICE_NAME"
echo ""
echo -e "  ${BLUE}# Reiniciar servicio${NC}"
echo "  sudo systemctl restart $SERVICE_NAME"
echo ""
echo -e "  ${BLUE}# Ver estado${NC}"
echo "  sudo systemctl status $SERVICE_NAME"
echo ""
echo -e "  ${BLUE}# Ver logs en tiempo real${NC}"
echo "  sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo -e "  ${BLUE}# Ver logs completos${NC}"
echo "  sudo journalctl -u $SERVICE_NAME -n 100"
echo ""

read -p "¿Deseas iniciar el servicio ahora? (s/n): " start_now

if [[ $start_now == "s" || $start_now == "S" ]]; then
    echo ""
    echo -e "${BLUE}🚀 Iniciando servicio...${NC}"
    systemctl start $SERVICE_NAME
    sleep 2
    
    if systemctl is-active --quiet $SERVICE_NAME; then
        echo -e "${GREEN}✅ Servicio iniciado correctamente${NC}"
        echo ""
        systemctl status $SERVICE_NAME --no-pager
    else
        echo -e "${RED}❌ Error al iniciar el servicio${NC}"
        echo -e "${YELLOW}Ver logs con: sudo journalctl -u $SERVICE_NAME -n 50${NC}"
    fi
fi

echo ""
echo -e "${GREEN}🎉 ¡Instalación finalizada!${NC}"
echo ""