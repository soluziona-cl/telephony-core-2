#!/bin/bash

###############################################################################
# 🎛️  Telephony Core Service Manager
# Script rápido para gestionar el servicio
###############################################################################

SERVICE_NAME="telephony-core"

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

show_usage() {
    echo -e "${BLUE}Uso: $0 {start|stop|restart|status|logs|tail|enable|disable|install}${NC}"
    echo ""
    echo "Comandos:"
    echo "  start    - Iniciar servicio"
    echo "  stop     - Detener servicio"
    echo "  restart  - Reiniciar servicio"
    echo "  status   - Ver estado del servicio"
    echo "  logs     - Ver logs completos (últimas 100 líneas)"
    echo "  tail     - Ver logs en tiempo real"
    echo "  enable   - Habilitar inicio automático"
    echo "  disable  - Deshabilitar inicio automático"
    echo "  install  - Ejecutar instalador"
    exit 1
}

check_root() {
    if [ "$EUID" -ne 0 ]; then 
        echo -e "${RED}❌ Este comando requiere permisos root${NC}"
        echo "   Usa: sudo $0 $1"
        exit 1
    fi
}

case "$1" in
    start)
        check_root "start"
        echo -e "${BLUE}🚀 Iniciando $SERVICE_NAME...${NC}"
        systemctl start $SERVICE_NAME
        sleep 2
        systemctl status $SERVICE_NAME --no-pager
        ;;
        
    stop)
        check_root "stop"
        echo -e "${YELLOW}🛑 Deteniendo $SERVICE_NAME...${NC}"
        systemctl stop $SERVICE_NAME
        echo -e "${GREEN}✅ Servicio detenido${NC}"
        ;;
        
    restart)
        check_root "restart"
        echo -e "${YELLOW}🔄 Reiniciando $SERVICE_NAME...${NC}"
        systemctl restart $SERVICE_NAME
        sleep 2
        systemctl status $SERVICE_NAME --no-pager
        ;;
        
    status)
        systemctl status $SERVICE_NAME
        ;;
        
    logs)
        echo -e "${BLUE}📜 Logs de $SERVICE_NAME (últimas 100 líneas):${NC}"
        journalctl -u $SERVICE_NAME -n 100 --no-pager
        ;;
        
    tail)
        echo -e "${BLUE}📡 Logs en tiempo real (Ctrl+C para salir):${NC}"
        journalctl -u $SERVICE_NAME -f
        ;;
        
    enable)
        check_root "enable"
        echo -e "${BLUE}⚙️  Habilitando inicio automático...${NC}"
        systemctl enable $SERVICE_NAME
        echo -e "${GREEN}✅ Servicio habilitado${NC}"
        ;;
        
    disable)
        check_root "disable"
        echo -e "${YELLOW}⚙️  Deshabilitando inicio automático...${NC}"
        systemctl disable $SERVICE_NAME
        echo -e "${GREEN}✅ Servicio deshabilitado${NC}"
        ;;
        
    install)
        check_root "install"
        if [ -f "./install-service.sh" ]; then
            bash ./install-service.sh
        else
            echo -e "${RED}❌ No se encontró install-service.sh${NC}"
            exit 1
        fi
        ;;
        
    *)
        show_usage
        ;;
esac

exit 0