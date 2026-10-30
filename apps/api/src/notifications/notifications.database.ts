import type { ModuleDatabase } from '../database/database.js';
import { NotificationsInit1793145600000 } from './migrations/1793145600000-notifications-init.js';
import { SentNotification } from './sent-notification.entity.js';

export const notificationsDatabase: ModuleDatabase = {
  module: 'notifications',
  entities: [SentNotification],
  migrations: [NotificationsInit1793145600000],
};
