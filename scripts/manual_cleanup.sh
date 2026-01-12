#!/bin/bash

# Configuration
DIRECTORIES=(
    "/var/lib/asterisk/sounds/voicebot/"
    "/var/spool/asterisk/recording/"
    "/opt/telephony-core/recordings/"
)
LOG_FILE="/var/log/telephony-manual-cleanup.log"

# Get days from argument or default to 1
DAYS=${1:-1}

echo "--- Starting MANUAL cleanup (Retaining $DAYS days) at $(date) ---" | sudo tee -a "$LOG_FILE"

for DIR in "${DIRECTORIES[@]}"; do
    if [ -d "$DIR" ]; then
        echo "Processing directory: $DIR" | sudo tee -a "$LOG_FILE"
        # Find and delete files older than $DAYS
        sudo find "$DIR" -type f -mtime +"$DAYS" -print -delete | sudo tee -a "$LOG_FILE"
    else
        echo "Directory not found: $DIR" | sudo tee -a "$LOG_FILE"
    fi
done

echo "--- Manual cleanup finished at $(date) ---" | sudo tee -a "$LOG_FILE"
echo "" | sudo tee -a "$LOG_FILE"

echo "Cleanup complete. Logs available at $LOG_FILE"
