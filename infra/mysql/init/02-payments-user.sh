#!/bin/bash
# Runs once, when the MySQL data volume is first created (Phase 8).
# The payments service gets its own login, which can see only its own database: the database "wall" between
# services is enforced by MySQL, not just by convention. Existing volumes: see docs/plans/phase-8-payments-service.md.
set -euo pipefail
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS scalecart_payments CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'payments'@'%' IDENTIFIED BY '${PAYMENTS_DB_PASSWORD}';
GRANT ALL PRIVILEGES ON scalecart_payments.* TO 'payments'@'%';
SQL
