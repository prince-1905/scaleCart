# Plan — Phase 13: MySQL read replica

Decided with the owner (2026-11-23): **read replicas** next. Branch `phase-13-read-replicas` from `main` after PR #19
(search) is merged. No new software: the replica uses the same `mysql:8.4.13` image.

## Today

One MySQL (2 CPUs) does everything: checkout's writes AND every read (product pages on a cache miss, product lists,
order history, the admin dashboard's stats: a 130 ms full scan, E8d). Reads compete with checkout for the same CPU
and disk.

## The idea

```
 writes + money reads ──────────────► MySQL primary ──binlog──► MySQL replica (read-only, a few ms behind)
 (checkout, cart, payments, stock)                                     ▲
 browsing reads ───────────────────────────────────────────────────────┘
 (product list/page on cache miss, order history, admin stats, search fallback)
```

- **Async replication with GTIDs:** the primary writes every change to its binary log; the replica copies and replays
  it. GTID = a global id per transaction, so the replica knows exactly where it is (and the app can ask "has the
  replica applied MY write yet?").
- **First copy:** MySQL's built-in CLONE plugin copies the primary's data (~180 MB) into the replica, then
  replication starts from that point (`SOURCE_AUTO_POSITION=1`).
- **Explicit routing, not automatic:** a separate read-only connection (`<module>_read`) used only by reads that may
  be a moment old. TypeORM's automatic `replication` option is NOT used: it would send every non-transaction SELECT to
  the replica, including price reads for checkout.
- **Read-your-writes:** right after I place an order, "My orders" must show it. Options to compare: (a) read from the
  primary for N seconds after a user's write (sticky); (b) remember the write's GTID and ask the replica to wait for
  it (`WAIT_FOR_EXECUTED_GTID_SET`, max ~50 ms), else read the primary. Plan: (b), measured against (a).
- **Lag guard:** a heartbeat row written to the primary every second; if the replica is more than N seconds behind
  (or down), reads go to the primary (circuit breaker) and a metric shows the lag.
- **Connection budget:** replica pools count too (E7c lesson).

## Steps

| Step | What |
|---|---|
| 13a | Primary: `gtid_mode=ON`, `enforce_gtid_consistency=ON`, distinct `server_id`; replication + clone users (init script + manual on the existing volume) |
| 13b | Compose `mysql-replica` (2 CPUs, own volume, `read_only` + `super_read_only`, port 127.0.0.1:3308), clone + start replication, healthcheck that includes "replica running" |
| 13c | App: `DB_READ_HOST`; read-only DataSources for catalog/orders; routed reads; heartbeat + lag metric (`mysql_replica_lag_seconds`); fallback to primary when lagging/down |
| 13d | Read-your-writes via GTID wait (and the sticky alternative behind a switch for the experiment) |
| 13e | Tests: routing (which reads go where), lag guard, read-your-writes (a mutation: no wait → the test fails) |
| 13f | E16 + docs |

## E16 — what we will measure

1. **Offload:** browsing + admin stats load: primary CPU and checkout latency with reads on the primary vs on the
   replica.
2. **Lag:** replica delay (heartbeat) at idle and during a checkout storm (E1-style), p50/p99/max.
3. **The stale-read bug:** place an order, read "My orders" from the replica at once: how often is it missing? Then
   with the GTID wait: missing count and the cost of the wait.
4. **Replica stopped / replication stopped for 30 s:** reads fall back to the primary, nothing fails; lag guard
   kicks in; catch-up time after it resumes.
5. **Replica can't take writes:** `super_read_only` refuses a write (proof it can't drift).

## Existing data volume (done 2026-11-25)

The init script `infra/mysql/init/04-replication-user.sh` only runs on a NEW volume. On the existing one, the same two
statements were run by hand as root:

```sql
CREATE USER IF NOT EXISTS 'replicator'@'%' IDENTIFIED BY '<REPLICATION_PASSWORD from .env>';
GRANT REPLICATION SLAVE, REPLICATION CLIENT, BACKUP_ADMIN ON *.* TO 'replicator'@'%';
```

then `docker compose up -d mysql` (GTIDs on, 12 s restart) and `docker compose up -d mysql-replica replica-setup`
(clone 50 s, replication started, read-only). Rebuilding the replica from scratch: `docker compose rm -sf mysql-replica`,
`docker volume rm scalecart_mysql-replica-data`, `docker compose up -d`.
