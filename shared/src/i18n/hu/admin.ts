import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Minden keresés és minden javaslat a Google Places-hez megy. Kikapcsolva előbb a PanelMint saját indexe és az OpenStreetMap válaszol, a Google-t csak akkor kérdezzük, ha ők nem találnak semmit.',
  'admin.placesGoogleOnly.missingKey': 'Google Maps API-kulcs kell hozzá. Nélküle a keresés a TREK indexén és az OpenStreetMapen fut, bárhogy áll is ez a kapcsoló.',
  'admin.placesGoogleOnly.otherProvider': 'A Google-t igényli helyszolgáltatóként. Amap vagy OpenStreetMap kiválasztásával egyetlen keresés sem megy a Google-höz, bárhogy áll is ez a kapcsoló.',
  'admin.packingTemplates.items': 'tétel',
  'admin.github.support': 'Segít fenntartani a PanelMint fejlesztését',
};
export default admin;
