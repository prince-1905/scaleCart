import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  /** Length over complexity rules (NIST SP 800-63B). The cap stops multi-MB "passwords". */
  @IsString()
  @Length(10, 128)
  password: string;
}

export class LoginDto {
  @IsString()
  @MaxLength(254)
  email: string;

  @IsString()
  @MaxLength(128)
  password: string;
}

export class RefreshDto {
  @IsString()
  @MaxLength(128)
  refreshToken: string;
}

/** A 6-digit code from the authenticator app, or a backup code ("abcd-efgh"). */
export class TwoFactorCodeDto {
  @IsString()
  @Length(6, 12)
  code: string;
}

export class LoginWithCodeDto extends TwoFactorCodeDto {
  @IsString()
  @MaxLength(2048)
  challengeToken: string;
}
