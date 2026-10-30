import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { ENV, type Env } from '../config/env.js';

export interface OrderEmail {
  to: string;
  orderId: string;
  totalCents: number;
  items: { name: string; quantity: number; unitPriceCents: number }[];
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Sends email over SMTP (Mailpit locally). Pooled: reuses a few open connections. */
@Injectable()
export class MailerService implements OnApplicationShutdown {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(@Inject(ENV) env: Env) {
    this.from = env.mailFrom;
    this.transport = createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: false,
      pool: true,
      maxConnections: 5,
      // A dead mail server must fail fast, not hang a request or a consumer.
      connectionTimeout: 3_000,
      greetingTimeout: 3_000,
      socketTimeout: 10_000,
    });
  }

  async sendOrderConfirmation(mail: OrderEmail): Promise<void> {
    const lines = mail.items.map((i) => `  ${i.quantity} x ${i.name}  ${money(i.unitPriceCents)}`);
    await this.transport.sendMail({
      from: this.from,
      to: mail.to,
      subject: `Order ${mail.orderId} confirmed`,
      text: [
        'Thanks for your order!',
        '',
        ...lines,
        '',
        `Total: ${money(mail.totalCents)}`,
        `Order id: ${mail.orderId}`,
      ].join('\n'),
    });
  }

  onApplicationShutdown() {
    this.transport.close();
  }
}
