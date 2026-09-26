import { authHandlers } from './auth';
import { settingsHandlers } from './settings';
import { addonHandlers } from './addons';
import { notificationHandlers } from './notifications';
import { vacayHandlers } from './vacay';
import { tripsHandlers } from './trips';
import { placesHandlers } from './places';
import { pluginSearchHandlers } from './pluginSearch';
import { filesHandlers } from './files';
import { tagsHandlers } from './tags';
import { adminHandlers } from './admin';
import { sharedHandlers } from './shared';
import { externalHandlers } from './external';

export const defaultHandlers = [
  ...authHandlers,
  ...settingsHandlers,
  ...addonHandlers,
  ...notificationHandlers,
  ...vacayHandlers,
  ...tripsHandlers,
  ...placesHandlers,
  ...pluginSearchHandlers,
  ...filesHandlers,
  ...tagsHandlers,
  ...adminHandlers,
  ...sharedHandlers,
  ...externalHandlers,
];
