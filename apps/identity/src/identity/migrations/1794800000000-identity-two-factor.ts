import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two-factor login with an authenticator app (TOTP), Phase 6b.
 * Kept out of `users`, so the login path that doesn't use 2FA reads nothing new.
 */
export class IdentityTwoFactor1794800000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // secret_enc: AES-256-GCM (12-byte nonce + ciphertext + 16-byte tag), never the plain secret.
    // enabled_at NULL = set up but not confirmed with a first code yet (login doesn't ask for it).
    // last_step: the 30 s step of the last accepted code; older or equal steps are refused (replay).
    // failed_codes / locked_until: wrong-code counter in MySQL, not Redis: Redis fails open, and a
    // 6-digit code must never get unlimited guesses.
    await q.query(`
      CREATE TABLE user_totp (
        user_id      CHAR(36) CHARACTER SET ascii NOT NULL,
        secret_enc   VARBINARY(128) NOT NULL,
        enabled_at   DATETIME(3) NULL,
        last_step    BIGINT NULL,
        failed_codes INT UNSIGNED NOT NULL DEFAULT 0,
        locked_until DATETIME(3) NULL,
        created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_id),
        CONSTRAINT fk_user_totp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE = InnoDB`);

    // One-time codes for a lost phone. Stored as a keyed hash (HMAC with a server key), so a stolen
    // table can't be brute-forced offline without the key.
    await q.query(`
      CREATE TABLE totp_backup_codes (
        user_id   CHAR(36) CHARACTER SET ascii NOT NULL,
        code_hash CHAR(64) CHARACTER SET ascii NOT NULL,
        used_at   DATETIME(3) NULL,
        PRIMARY KEY (user_id, code_hash),
        CONSTRAINT fk_totp_backup_codes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE totp_backup_codes');
    await q.query('DROP TABLE user_totp');
  }
}
