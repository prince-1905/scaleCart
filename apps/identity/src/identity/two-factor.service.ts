import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { ENV, type Env } from '../config/env.js';
import { isDuplicateKey, type WriteResult } from '../database/database.js';
import { MetricsService } from '../observability/metrics.service.js';
import { base32Encode, matchTotp, newTotpSecret, otpauthUrl } from './totp.js';

const BACKUP_CODE_COUNT = 10;
/** No 0/o, 1/l/i: backup codes get read off paper. 31 symbols × 8 = ~40 bits each. */
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

interface TotpRow {
  secret_enc: Buffer;
  enabled_at: Date | null;
  last_step: string | number | null;
}

export interface TwoFactorSetup {
  /** For typing in by hand (base32). */
  secret: string;
  /** For the QR code. */
  otpauthUrl: string;
}

/**
 * Two-factor login with an authenticator app (TOTP).
 *
 * Guessing: a 6-digit code has 1,000,000 values and we accept 3 (one step either side), so every
 * guess must cost. Each check first *reserves* an attempt with one conditional UPDATE: at most
 * TWO_FACTOR_MAX_FAILURES wrong codes, even when the guesses arrive in parallel, then the account's
 * code check is locked for TWO_FACTOR_LOCK_SECONDS. The counter is in MySQL because Redis fails
 * open: a Redis outage must not mean unlimited guesses.
 */
@Injectable()
export class TwoFactorService {
  private readonly secretKey: Buffer;
  private readonly backupKey: Buffer;

  constructor(
    @InjectDataSource('identity') private readonly db: DataSource,
    @Inject(ENV) private readonly env: Env,
    private readonly metrics: MetricsService,
  ) {
    // Keys of their own, derived from one root, so the TOTP key never doubles as a token key.
    const root = env.totpEncryptionKey || env.jwtSecret;
    this.secretKey = createHmac('sha256', root).update('scalecart totp secret v1').digest();
    this.backupKey = createHmac('sha256', root).update('scalecart totp backup codes v1').digest();
  }

  async isEnabled(userId: string): Promise<boolean> {
    const rows: { n: number }[] = await this.db.query(
      'SELECT COUNT(*) AS n FROM user_totp WHERE user_id = ? AND enabled_at IS NOT NULL',
      [userId],
    );
    return Number(rows[0]?.n) > 0;
  }

  /** Step 1: a new secret (not active yet). Calling it again before confirming replaces the secret. */
  async setup(userId: string, email: string): Promise<TwoFactorSetup> {
    const secret = newTotpSecret();
    const encrypted = this.encrypt(secret);
    const replaced: WriteResult = await this.db.query(
      `UPDATE user_totp SET secret_enc = ?, last_step = NULL, failed_codes = 0, locked_until = NULL
        WHERE user_id = ? AND enabled_at IS NULL`,
      [encrypted, userId],
    );
    if (replaced.affectedRows === 0) {
      try {
        await this.db.query('INSERT INTO user_totp (user_id, secret_enc) VALUES (?, ?)', [userId, encrypted]);
      } catch (err) {
        // A row exists and is enabled (or a parallel setup won): turning it on twice is a mistake.
        if (isDuplicateKey(err)) throw this.alreadyEnabled();
        throw err;
      }
    }
    return { secret: base32Encode(secret), otpauthUrl: otpauthUrl(secret, email) };
  }

  /** Step 2: the first code from the app proves the phone has the secret. Returns the backup codes, once. */
  async enable(userId: string, code: string): Promise<{ backupCodes: string[] }> {
    const row = await this.row(userId);
    if (!row) throw new ConflictException({ statusCode: 409, error: 'two_factor_not_set_up', message: 'call setup first' });
    if (row.enabled_at) throw this.alreadyEnabled();
    await this.check(userId, row, code, { allowBackup: false, signedIn: true });

    const enabled: WriteResult = await this.db.query(
      'UPDATE user_totp SET enabled_at = NOW(3) WHERE user_id = ? AND enabled_at IS NULL',
      [userId],
    );
    if (enabled.affectedRows !== 1) throw this.alreadyEnabled();
    this.metrics.twoFactor.inc({ result: 'enabled' });
    return { backupCodes: await this.newBackupCodes(userId) };
  }

  /** At login, after the password: a code from the app, or one unused backup code. */
  async verifyForLogin(userId: string, code: string): Promise<void> {
    const row = await this.row(userId);
    if (!row?.enabled_at) throw new UnauthorizedException('two-factor login is not enabled');
    await this.check(userId, row, code, { allowBackup: true, signedIn: false });
  }

  /** Needs a current code (or a backup code): a stolen access token alone can't switch 2FA off. */
  async disable(userId: string, code: string): Promise<void> {
    const row = await this.row(userId);
    if (!row?.enabled_at) throw new ConflictException({ statusCode: 409, error: 'two_factor_not_enabled', message: 'two-factor login is not enabled' });
    await this.check(userId, row, code, { allowBackup: true, signedIn: true });
    await this.db.query('DELETE FROM totp_backup_codes WHERE user_id = ?', [userId]);
    await this.db.query('DELETE FROM user_totp WHERE user_id = ?', [userId]);
    this.metrics.twoFactor.inc({ result: 'disabled' });
  }

  /** New backup codes (the old ones stop working). Needs a code from the app. */
  async regenerateBackupCodes(userId: string, code: string): Promise<{ backupCodes: string[] }> {
    const row = await this.row(userId);
    if (!row?.enabled_at) throw new ConflictException({ statusCode: 409, error: 'two_factor_not_enabled', message: 'two-factor login is not enabled' });
    await this.check(userId, row, code, { allowBackup: false, signedIn: true });
    return { backupCodes: await this.newBackupCodes(userId) };
  }

  /**
   * Reserve an attempt → check the code → on success clear the counter; on failure lock once the
   * limit is reached. Throws 429 (locked), or for a wrong code: 401 at login, 400 when already signed in.
   * Why 400 there: clients (our shop too) treat a 401 as "access token expired", refresh and send the
   * request again, which spent 2 of the 5 attempts per wrong code and rotated the user's tokens.
   */
  private async check(
    userId: string,
    row: TotpRow,
    code: string,
    opts: { allowBackup: boolean; signedIn: boolean },
  ): Promise<void> {
    const max = this.env.twoFactorMaxFailures;
    const slot: WriteResult = await this.db.query(
      `UPDATE user_totp SET failed_codes = failed_codes + 1
        WHERE user_id = ? AND failed_codes < ? AND (locked_until IS NULL OR locked_until <= NOW(3))`,
      [userId, max],
    );
    if (slot.affectedRows !== 1) throw await this.locked(userId);

    const normalized = code.replace(/[\s-]/g, '').toLowerCase();
    const lastStep = row.last_step === null ? null : Number(row.last_step);
    const step = matchTotp(this.decrypt(row.secret_enc), normalized, Date.now(), lastStep);
    if (step !== null) {
      // Conditional on the step, so two parallel logins with the same code can't both pass.
      const used: WriteResult = await this.db.query(
        `UPDATE user_totp SET last_step = ?, failed_codes = 0
          WHERE user_id = ? AND (last_step IS NULL OR last_step < ?)`,
        [step, userId, step],
      );
      if (used.affectedRows === 1) {
        this.metrics.twoFactor.inc({ result: 'code_ok' });
        return;
      }
    } else if (opts.allowBackup && /^[a-z0-9]{8}$/.test(normalized)) {
      const used: WriteResult = await this.db.query(
        'UPDATE totp_backup_codes SET used_at = NOW(3) WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
        [userId, this.backupHash(normalized)],
      );
      if (used.affectedRows === 1) {
        await this.db.query('UPDATE user_totp SET failed_codes = 0 WHERE user_id = ?', [userId]);
        this.metrics.twoFactor.inc({ result: 'backup_code_ok' });
        return;
      }
    }

    // Wrong (or replayed) code: this attempt stays counted; at the limit, lock and start over.
    await this.db.query(
      `UPDATE user_totp SET locked_until = NOW(3) + INTERVAL ? SECOND, failed_codes = 0
        WHERE user_id = ? AND failed_codes >= ?`,
      [this.env.twoFactorLockSeconds, userId, max],
    );
    this.metrics.twoFactor.inc({ result: 'wrong_code' });
    const wrong = { error: 'invalid_code', message: 'wrong or expired code' };
    throw opts.signedIn
      ? new BadRequestException({ statusCode: 400, ...wrong })
      : new UnauthorizedException({ statusCode: 401, ...wrong });
  }

  private async locked(userId: string): Promise<HttpException> {
    const rows: { wait: number | null }[] = await this.db.query(
      'SELECT CEIL(TIMESTAMPDIFF(MICROSECOND, NOW(3), locked_until) / 1e6) AS wait FROM user_totp WHERE user_id = ?',
      [userId],
    );
    this.metrics.twoFactor.inc({ result: 'locked' });
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'two_factor_locked',
        message: 'too many wrong codes; try again later',
        retryAfterSeconds: Math.max(1, Number(rows[0]?.wait ?? 1)),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private async newBackupCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
      Array.from({ length: 8 }, () => BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)]).join(''),
    );
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM totp_backup_codes WHERE user_id = ?', [userId]);
      await tx.query(
        `INSERT INTO totp_backup_codes (user_id, code_hash) VALUES ${codes.map(() => '(?, ?)').join(', ')}`,
        codes.flatMap((c) => [userId, this.backupHash(c)]),
      );
    });
    // Shown as "abcd-efgh"; typed with or without the dash.
    return codes.map((c) => `${c.slice(0, 4)}-${c.slice(4)}`);
  }

  private async row(userId: string): Promise<TotpRow | undefined> {
    const rows: TotpRow[] = await this.db.query(
      'SELECT secret_enc, enabled_at, last_step FROM user_totp WHERE user_id = ?',
      [userId],
    );
    return rows[0];
  }

  private backupHash(code: string): string {
    return createHmac('sha256', this.backupKey).update(code).digest('hex');
  }

  /** AES-256-GCM: nonce (12) + ciphertext + tag (16). The tag also detects a tampered row. */
  private encrypt(secret: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secretKey, nonce);
    const body = Buffer.concat([cipher.update(secret), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]);
  }

  private decrypt(blob: Buffer): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', this.secretKey, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]);
  }

  private alreadyEnabled() {
    return new ConflictException({ statusCode: 409, error: 'two_factor_already_enabled', message: 'two-factor login is already on' });
  }
}
