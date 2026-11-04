import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post } from '@nestjs/common';
import { IsInt, IsISO8601, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { CurrentUser, Public, Roles, type AuthUser } from '../common/auth.js';
import { DropsService } from './drops.service.js';

export class CreateDropDto {
  @IsInt()
  @Min(1)
  productId: number;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  /** e.g. "2026-11-05T14:30:00Z" */
  @IsISO8601({ strict: true })
  startsAt: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxPerCustomer: number = 1;

  /** How many buyers the waiting room lets through per second. Measure checkout capacity first (E5). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  admitPerSecond: number = 50;

  /** "One out, one in": at most this many buyers shopping at once; a place frees when one finishes. Overrides admitPerSecond. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxShoppers?: number;
}

@Controller('drops')
export class DropsController {
  constructor(private readonly drops: DropsService) {}

  @Roles('admin')
  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateDropDto) {
    return this.drops.create({
      productId: dto.productId,
      name: dto.name,
      startsAt: new Date(dto.startsAt),
      maxPerCustomer: dto.maxPerCustomer,
      admitPerSecond: dto.admitPerSecond,
      maxShoppers: dto.maxShoppers ?? null,
    });
  }

  @Public()
  @Get()
  list() {
    return this.drops.list();
  }

  @Public()
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const drop = await this.drops.get(id);
    if (!drop) throw new NotFoundException('drop not found');
    return drop;
  }

  /**
   * Join the line, or ask where you are: the same call does both, so clients just repeat it.
   * Once your ticket is called, the answer includes the pass checkout needs.
   */
  @Post(':id/queue')
  @HttpCode(200)
  queue(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.drops.queue(id, user.id);
  }
}
