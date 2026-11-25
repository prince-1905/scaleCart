#!/bin/bash
# Phase 13: makes `mysql-replica` a read-only copy of `mysql` (the primary). Idempotent: Compose runs it on every
# `up` (service replica-setup); if replication is already set up it only prints the status.
#
#   1. empty replica → CLONE INSTANCE copies the primary's data (MySQL's clone plugin), then the replica restarts
#   2. CHANGE REPLICATION SOURCE ... SOURCE_AUTO_POSITION=1: follow the primary's binary log from the cloned point
#      (GTIDs tell it exactly which transactions it already has)
#   3. super_read_only=ON, persisted: nobody (not even root) can write to the copy, so it can't drift
set -euo pipefail
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"
replica() { mysql -h mysql-replica -uroot -N -B "$@"; }
status() { mysql -h mysql-replica -uroot -e 'SHOW REPLICA STATUS\G' | grep -E 'Replica_IO_Running:|Replica_SQL_Running:|Seconds_Behind_Source:|Last_(IO_|SQL_)?Error:' || true; }
wait_replica() {
  for _ in $(seq 1 120); do
    if replica -e 'SELECT 1' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "replica did not come back" >&2
  return 1
}

wait_replica
if [ -n "$(replica -e 'SHOW REPLICA STATUS')" ]; then
  echo "replication already set up:"
  status
  exit 0
fi

echo "cloning the primary into the replica..."
start=$(date +%s)
# The replica shuts itself down after a clone (Compose restarts it): the client then reports an error, expected.
replica -e "SET GLOBAL clone_valid_donor_list = 'mysql:3306';
            CLONE INSTANCE FROM 'replicator'@'mysql':3306 IDENTIFIED BY '${REPLICATION_PASSWORD}';" || true
sleep 5
wait_replica
echo "clone done in $(( $(date +%s) - start )) s"

replica -e "CHANGE REPLICATION SOURCE TO
              SOURCE_HOST = 'mysql', SOURCE_PORT = 3306,
              SOURCE_USER = 'replicator', SOURCE_PASSWORD = '${REPLICATION_PASSWORD}',
              SOURCE_AUTO_POSITION = 1, GET_SOURCE_PUBLIC_KEY = 1;
            START REPLICA;
            SET PERSIST read_only = ON;
            SET PERSIST super_read_only = ON;"
sleep 2
status
