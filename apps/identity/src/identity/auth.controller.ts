import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CurrentUser, Public, type AuthUser } from '../common/auth.js';
import { LoginDto, LoginWithCodeDto, RefreshDto, RegisterDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { RateLimit } from '../rate-limit/rate-limit.js';

/**
 * Tokens travel in JSON bodies so any client (and k6) can use them. A browser app
 * would rather keep the refresh token in an HttpOnly, SameSite cookie, out of
 * reach of JavaScript (and of XSS).
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit('auth')
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto.email, dto.password);
  }

  @Public()
  @RateLimit('auth')
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Step two for accounts with 2FA: the challenge token from /auth/login + a code. */
  @Public()
  @RateLimit('auth')
  @Post('login/2fa')
  @HttpCode(200)
  loginWithCode(@Body() dto: LoginWithCodeDto) {
    return this.auth.loginWithCode(dto.challengeToken, dto.code);
  }

  @Public()
  @RateLimit('auth')
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}
