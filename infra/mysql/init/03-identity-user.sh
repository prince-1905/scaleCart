#!/bin/bash
# Runs once, when the MySQL data volume is first created (Phase 11).
# The identity service gets its own login, which can see only its own database (users, refresh tokens, 2FA).
# Existing volumes: see docs/plans/phase-11-identity-service.md.
set -euo pipefail
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS scalecart_identity CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'identity'@'%' IDENTIFIED BY '${IDENTITY_DB_PASSWORD}';
GRANT ALL PRIVILEGES ON scalecart_identity.* TO 'identity'@'%';
SQL
