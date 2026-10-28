import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, IsNull } from 'typeorm';
import type { Role } from '../common/auth.js';
import { uuidv7 } from '../common/uuid.js';
import { ENV, type Env } from '../config/env.js';
import { isDuplicateKey, type WriteResult } from '../database/database.js';
import { PasswordHasher } from './password-hasher.js';
import { RefreshToken } from './refresh-token.entity.js';
import { User } from './user.entity.js';

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  refreshToken: string;
}

export interface AccessTokenClaims {
  sub: string;
  role: Role;
}

/**
 * Refresh tokens are 256 random bits, so a fast hash is enough to store them:
 * nobody can brute-force 2^256 guesses. (Passwords are short and guessable, which
 * is why they need slow Argon2id instead.)
 */
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const INVALID_LOGIN = 'invalid email or password';
const INVALID_REFRESH = 'invalid refresh token';

@Injectable()
export class AuthService {
  private readonly users;
  private readonly tokens;

  constructor(
    @InjectDataSource('identity') private readonly db: DataSource,
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
    private readonly hasher: PasswordHasher,
  ) {
    this.users = db.getRepository(User);
    this.tokens = db.getRepository(RefreshToken);
  }

  async register(email: string, password: string): Promise<TokenPair> {
    const user = this.users.create({
      id: uuidv7(),
      email: normalizeEmail(email),
      passwordHash: await this.hasher.hash(password),
      role: 'customer',
    });
    try {
      await this.users.insert(user);
    } catch (err) {
      // The UNIQUE index decides, not a SELECT beforehand: two simultaneous sign-ups
      // with one email would both pass a "does it exist?" check.
      if (isDuplicateKey(err)) throw new ConflictException('email is already registered');
      throw err;
    }
    return this.issueTokens(user, uuidv7());
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.users.findOneBy({ email: normalizeEmail(email) });
    const ok = user
      ? await this.hasher.verify(user.passwordHash, password)
      : await this.hasher.verifyAgainstDummy(password);
    if (!user || !ok) throw new UnauthorizedException(INVALID_LOGIN);
    return this.issueTokens(user, uuidv7());
  }

  /**
   * Refresh-token rotation: every refresh token works once. Using it returns a new
   * access token and a new refresh token from the same family.
   *
   * If an already-used token shows up again, two parties hold copies (one of them is
   * probably a thief), and we can't tell which is which. So the whole family is
   * revoked and the user must log in again.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const row = await this.tokens.findOneBy({ tokenHash: sha256(refreshToken) });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    // Atomic "use once": of two concurrent refreshes with the same token, exactly one
    // matches `used_at IS NULL`; the other sees 0 affected rows.
    const claimed: WriteResult = await this.db.query(
      `UPDATE refresh_tokens SET used_at = NOW(3)
        WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      [row.id],
    );
    if (claimed.affectedRows !== 1) {
      await this.revokeFamily(row.familyId);
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    const user = await this.users.findOneBy({ id: row.userId });
    if (!user) throw new UnauthorizedException(INVALID_REFRESH);
    return this.issueTokens(user, row.familyId);
  }

  /** Ends this login session (the token's family). Unknown tokens are ignored. */
  async logout(refreshToken: string): Promise<void> {
    const row = await this.tokens.findOneBy({ tokenHash: sha256(refreshToken) });
    if (row) await this.revokeFamily(row.familyId);
  }

  async me(userId: string) {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new UnauthorizedException();
    return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt };
  }

  private async revokeFamily(familyId: string) {
    await this.tokens.update({ familyId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  private async issueTokens(user: User, familyId: string): Promise<TokenPair> {
    const claims: AccessTokenClaims = { sub: user.id, role: user.role };
    const accessToken = await this.jwt.signAsync(claims);

    const refreshToken = randomBytes(32).toString('base64url');
    await this.tokens.insert({
      id: uuidv7(),
      userId: user.id,
      familyId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + this.env.refreshTokenTtlDays * 86_400_000),
    });

    return {
      tokenType: 'Bearer',
      accessToken,
      expiresIn: this.env.accessTokenTtlSeconds,
      refreshToken,
    };
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
