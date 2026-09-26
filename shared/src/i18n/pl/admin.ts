import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Każde wyszukiwanie i każda podpowiedź trafia do Google Places. Wyłączone: najpierw odpowiadają indeks PanelMint i OpenStreetMap, a Google jest pytany tylko wtedy, gdy nic nie znajdą.',
  'admin.placesGoogleOnly.missingKey': 'Wymaga klucza Google Maps API. Bez niego wyszukiwanie działa przez indeks PanelMint i OpenStreetMap, niezależnie od tego przełącznika.',
  'admin.placesGoogleOnly.otherProvider': 'Wymaga Google jako dostawcy miejsc. Przy wybranym Amap lub OpenStreetMap żadne wyszukiwanie nie trafia do Google, niezależnie od tego przełącznika.',
  'admin.packingTemplates.items': 'przedmiotów',
  'admin.github.support': 'Pomóż mi rozwijać PanelMint',
};
export default admin;
