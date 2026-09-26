import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Elke zoekopdracht en elke suggestie gaat naar Google Places. Uit, antwoorden eerst de PanelMint-index en OpenStreetMap; Google wordt alleen gevraagd als die niets vinden.',
  'admin.placesGoogleOnly.missingKey': 'Vereist een Google Maps API-sleutel. Zonder sleutel zoekt PanelMint via de eigen index en OpenStreetMap, wat deze schakelaar ook zegt.',
  'admin.placesGoogleOnly.otherProvider': 'Vereist Google als plaatsenprovider. Met Amap of OpenStreetMap gekozen gaat geen enkele zoekopdracht naar Google, wat deze schakelaar ook zegt.',
  'admin.packingTemplates.items': 'items',
  'admin.github.support': 'Helpt mij PanelMint verder te ontwikkelen',
};
export default admin;
