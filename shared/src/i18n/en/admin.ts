import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Every search and every suggestion goes to Google Places. Off, PanelMint\'s own index and OpenStreetMap answer first and Google is only asked when they find nothing.',
  'admin.placesGoogleOnly.missingKey': 'Needs a Google Maps API key. Without one, search runs on PanelMint\'s own index and OpenStreetMap whatever this switch says.',
  'admin.placesGoogleOnly.otherProvider': 'Needs Google as the places provider. With Amap or OpenStreetMap picked, search never goes to Google whatever this switch says.',
  'admin.packingTemplates.items': 'items',
  'admin.github.support': 'Helps me keep building TREK',
};
export default admin;
