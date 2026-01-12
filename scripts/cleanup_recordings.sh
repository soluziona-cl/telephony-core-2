#!/bin/bash

# Configuration
DIRECTORIES=(
    "/var/lib/asterisk/sounds/voicebot/"
    "/var/spool/asterisk/recording/"
    "/opt/telephony-core/recordings/"
)
DAYS_TO_KEEP=1
LOG_FILE="/var/log/telephony-cleanup.log"

# Ensure log file exists and is writable
sudo touch "$LOG_FILE" 2>/dev/null
sudo chmod 666 "$LOG_FILE" 2>/dev/null

echo "--- Starting cleanup at $(date) ---" >> "$LOG_FILE"

for DIR in "${DIRECTORIES[@]}"; do
    if [ -d "$DIR" ]; then
        echo "Processing directory: $DIR" >> "$LOG_FILE"
        # Find and delete files older than DAYS_TO_KEEP
        # We use -type f to only delete files, and -mtime +$DAYS_TO_KEEP
        sudo find "$DIR" -type f -mtime +"$DAYS_TO_KEEP" -print -delete >> "$LOG_FILE" 2>&1
    else
        echo "Directory not found: $DIR" >> "$LOG_FILE"
    fi
done

echo "--- Cleanup finished at $(date) ---" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"
