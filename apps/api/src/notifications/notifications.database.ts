import type { ModuleDatabase } from '../database/database.js';
import { NotificationsInit1793145600000 } from './migrations/1793145600000-notifications-init.js';
import { NotificationClaims1795500000000 } from './migrations/1795500000000-notification-claims.js';
import { SentNotification } from './sent-notification.entity.js';

export const notificationsDatabase: ModuleDatabase = {
  module: 'notifications',
  entities: [SentNotification],
  migrations: [NotificationsInit1793145600000, NotificationClaims1795500000000],
};
