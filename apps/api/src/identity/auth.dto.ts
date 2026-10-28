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
