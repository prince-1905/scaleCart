import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/auth.js';
import { RateLimit } from '../rate-limit/rate-limit.js';
import { TwoFactorCodeDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { TwoFactorService } from './two-factor.service.js';

/**
 * Turning 2FA on and off, for the logged-in user:
 *   setup → secret + QR link · enable {code} → backup codes (shown once) · disable {code} ·
 *   backup-codes {code} → a fresh set
 */
@Controller('auth/2fa')
export class TwoFactorController {
  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly auth: AuthService,
  ) {}

  @Post('setup')
  @HttpCode(200)
  async setup(@CurrentUser() user: AuthUser) {
    const { email } = await this.auth.me(user.id);
    return this.twoFactor.setup(user.id, email);
  }

  @RateLimit('auth')
  @Post('enable')
  @HttpCode(200)
  enable(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorCodeDto) {
    return this.twoFactor.enable(user.id, dto.code);
  }

  @RateLimit('auth')
  @Post('disable')
  @HttpCode(204)
  async disable(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorCodeDto) {
    await this.twoFactor.disable(user.id, dto.code);
  }

  @RateLimit('auth')
  @Post('backup-codes')
  @HttpCode(200)
  backupCodes(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorCodeDto) {
    return this.twoFactor.regenerateBackupCodes(user.id, dto.code);
  }
}
