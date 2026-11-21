import { Controller, Get, Header, Inject, ParseArrayPipe, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Internal, Public } from '../common/auth.js';
import { SigningKeys } from '../keys/signing-keys.js';
import { SkipRateLimit } from '../rate-limit/rate-limit.js';
import { User } from './user.entity.js';

/** The public keys that check access tokens (JWKS, RFC 7517). Anyone may read them: they can't create tokens. */
@Public()
@SkipRateLimit()
@Controller('.well-known')
export class JwksController {
  constructor(@Inject(SigningKeys) private readonly keys: SigningKeys) {}

  @Get('jwks.json')
  // Verifiers cache this; a new key is picked up when a token with an unknown kid arrives (or after 5 min).
  @Header('Cache-Control', 'public, max-age=300')
  jwks() {
    return this.keys.jwks();
  }
}

/**
 * The one thing the rest of the shop needs from identity: a user's email address (confirmation emails, the admin's
 * order list). Service token only; the gateway never routes /internal/*.
 */
@Internal()
@SkipRateLimit()
@Controller('internal/users')
export class InternalUsersController {
  constructor(@InjectRepository(User, 'identity') private readonly users: Repository<User>) {}

  /** GET /internal/users?ids=a,b,c → { users: [{ id, email }] } (unknown ids are left out). */
  @Get()
  async byIds(@Query('ids', new ParseArrayPipe({ items: String, separator: ',' })) ids: string[]) {
    const wanted = [...new Set(ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 200);
    if (wanted.length === 0) return { users: [] };
    const rows = await this.users.find({ where: { id: In(wanted) }, select: { id: true, email: true } });
    return { users: rows.map((u) => ({ id: u.id, email: u.email })) };
  }
}
