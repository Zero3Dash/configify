#!/bin/bash
# configify — daily PostgreSQL backup
# Installed to /usr/local/bin/backup-configify-db.sh
# Cron: 0 2 * * * /usr/local/bin/backup-configify-db.sh

BACKUP_DIR="/var/backups/postgresql"
DATE=$(date +%Y%m%d_%H%M%S)
DB_NAME="configify_db"

mkdir -p "$BACKUP_DIR"

sudo -u postgres pg_dump "$DB_NAME" \
    | gzip > "${BACKUP_DIR}/${DB_NAME}_${DATE}.sql.gz"

# Prune backups older than 7 days
find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime +7 -delete

echo "[$(date -Iseconds)] Backup completed: ${DB_NAME}_${DATE}.sql.gz"
