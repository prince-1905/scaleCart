import type { MigrationInterface, QueryRunner } from 'typeorm';

export class IdentityInit1793059200000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // UUIDs are ASCII: CHARACTER SET ascii stores them in 36 bytes instead of up to 144 (utf8mb4).
    await q.query(`
      CREATE TABLE users (
        id            CHAR(36) CHARACTER SET ascii NOT NULL,
        email         VARCHAR(254) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role          ENUM('customer', 'admin') NOT NULL DEFAULT 'customer',
        created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_email (email)
      ) ENGINE = InnoDB`);

    await q.query(`
      CREATE TABLE refresh_tokens (
        id          CHAR(36) CHARACTER SET ascii NOT NULL,
        user_id     CHAR(36) CHARACTER SET ascii NOT NULL,
        family_id   CHAR(36) CHARACTER SET ascii NOT NULL,
        token_hash  CHAR(64) CHARACTER SET ascii NOT NULL,
        expires_at  DATETIME(3) NOT NULL,
        used_at     DATETIME(3) NULL,
        revoked_at  DATETIME(3) NULL,
        created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_refresh_tokens_hash (token_hash),
        KEY ix_refresh_tokens_family (family_id),
        CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE = InnoDB`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE refresh_tokens');
    await q.query('DROP TABLE users');
  }
}
