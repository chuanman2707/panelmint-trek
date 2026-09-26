import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Jede Suche und jeder Vorschlag geht an Google Places. Aus, antworten zuerst der PanelMint-Index und OpenStreetMap, Google wird nur gefragt, wenn beide nichts finden.',
  'admin.placesGoogleOnly.missingKey': 'Braucht einen Google-Maps-API-Schlüssel. Ohne ihn läuft die Suche über den PanelMint-Index und OpenStreetMap, egal wie dieser Schalter steht.',
  'admin.placesGoogleOnly.otherProvider': 'Braucht Google als Orts-Anbieter. Mit Amap oder OpenStreetMap als Auswahl geht keine Suche an Google, egal wie dieser Schalter steht.',
  'admin.packingTemplates.items': 'Einträge',
  'admin.github.support': 'Hilft mir, PanelMint weiterzuentwickeln',
};
export default admin;
