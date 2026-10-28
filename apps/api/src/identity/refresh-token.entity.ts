import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * One row per issued refresh token. Only a SHA-256 hash is stored, so a database
 * leak doesn't hand out working tokens. All tokens from one login share a family.
 */
@Entity({ name: 'refresh_tokens' })
export class RefreshToken {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ name: 'user_id', type: 'char', length: 36 })
  userId: string;

  @Column({ name: 'family_id', type: 'char', length: 36 })
  familyId: string;

  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  @Column({ name: 'expires_at', type: 'datetime', precision: 3 })
  expiresAt: Date;

  /** Set when this token was exchanged for a new one. Presenting it again = reuse. */
  @Column({ name: 'used_at', type: 'datetime', precision: 3, nullable: true })
  usedAt: Date | null;

  @Column({ name: 'revoked_at', type: 'datetime', precision: 3, nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}
