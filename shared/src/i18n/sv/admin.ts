import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Varje sökning och varje förslag går till Google Places. Av svarar PanelMint:s eget index och OpenStreetMap först, och Google tillfrågas bara när de inte hittar något.',
  'admin.placesGoogleOnly.missingKey': 'Kräver en Google Maps API-nyckel. Utan nyckel söker PanelMint via sitt eget index och OpenStreetMap, oavsett hur den här brytaren står.',
  'admin.placesGoogleOnly.otherProvider': 'Kräver Google som platsleverantör. Med Amap eller OpenStreetMap valt går ingen sökning till Google, oavsett hur den här väljaren står.',
  'admin.packingTemplates.items': 'föremål',
  'admin.github.support': 'Hjälper mig att fortsätta bygga PanelMint',
};
export default admin;
