import type { ModuleDatabase } from '../database/database.js';
import { PaymentsInit1793318400000 } from './migrations/1793318400000-payments-init.js';
import { Payment, PaymentAttempt, WebhookEvent } from './payment.entities.js';

export const paymentsDatabase: ModuleDatabase = {
  module: 'payments',
  entities: [PaymentAttempt, Payment, WebhookEvent],
  migrations: [PaymentsInit1793318400000],
};
