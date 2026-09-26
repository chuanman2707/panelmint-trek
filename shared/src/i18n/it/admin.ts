import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Ogni ricerca e ogni suggerimento vanno a Google Places. Spento, rispondono prima l\'indice di PanelMint e OpenStreetMap, e Google viene interrogato solo se non trovano nulla.',
  'admin.placesGoogleOnly.missingKey': 'Richiede una chiave API di Google Maps. Senza, la ricerca usa l\'indice di PanelMint e OpenStreetMap, comunque sia impostato questo interruttore.',
  'admin.placesGoogleOnly.otherProvider': 'Richiede Google come provider dei luoghi. Con Amap o OpenStreetMap selezionati, nessuna ricerca va a Google, qualunque sia la posizione di questo interruttore.',
  'admin.packingTemplates.items': 'elementi',
  'admin.github.support': 'Mi aiuta a continuare a sviluppare PanelMint',
};
export default admin;
