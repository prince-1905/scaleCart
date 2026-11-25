#!/bin/bash
# Runs once, when the MySQL data volume is first created (Phase 13).
# The read replica's login: it may copy the whole server once (CLONE, needs BACKUP_ADMIN) and then follow the binary
# log (REPLICATION SLAVE). It can't read or change any table through normal queries.
# Existing volumes: run the same statements by hand (see docs/plans/phase-13-read-replicas.md).
set -euo pipefail
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE USER IF NOT EXISTS 'replicator'@'%' IDENTIFIED BY '${REPLICATION_PASSWORD}';
GRANT REPLICATION SLAVE, REPLICATION CLIENT, BACKUP_ADMIN ON *.* TO 'replicator'@'%';
SQL
