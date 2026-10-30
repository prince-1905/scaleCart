import { Module } from '@nestjs/common';
import { MailerService } from './mailer.service.js';

/** Email sending only (no database), so the API can use it in the sync-email experiment. */
@Module({
  providers: [MailerService],
  exports: [MailerService],
})
export class MailerModule {}
