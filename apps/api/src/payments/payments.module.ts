import { Module } from '@nestjs/common';
import { PaymentsCoreModule } from './payments-core.module.js';
import { PaymentsController } from './payments.controller.js';

@Module({
  imports: [PaymentsCoreModule],
  controllers: [PaymentsController],
})
export class PaymentsModule {}
