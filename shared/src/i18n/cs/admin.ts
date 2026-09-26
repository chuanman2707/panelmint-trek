import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Každé hledání a každý návrh jde do Google Places. Vypnuto: nejprve odpovídá index PanelMint a OpenStreetMap, Google se ptáme jen tehdy, když nic nenajdou.',
  'admin.placesGoogleOnly.missingKey': 'Vyžaduje klíč Google Maps API. Bez něj hledání běží přes index PanelMint a OpenStreetMap bez ohledu na tento přepínač.',
  'admin.placesGoogleOnly.otherProvider': 'Vyžaduje Google jako poskytovatele míst. Při zvoleném Amapu nebo OpenStreetMap nejde na Google žádné hledání, ať je tento přepínač nastaven jakkoli.',
  'admin.packingTemplates.items': 'položek',
  'admin.github.support': 'Pomáhá udržovat vývoj PanelMint',
};
export default admin;
