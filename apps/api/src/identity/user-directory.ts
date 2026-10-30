import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity.js';

/**
 * Identity's public read API for other modules (e.g. notifications needs an email
 * address). After the microservice split this becomes an HTTP call or an event.
 */
@Injectable()
export class UserDirectory {
  constructor(@InjectRepository(User, 'identity') private readonly users: Repository<User>) {}

  async getEmail(userId: string): Promise<string | null> {
    const user = await this.users.findOne({ where: { id: userId }, select: { email: true } });
    return user?.email ?? null;
  }
}
