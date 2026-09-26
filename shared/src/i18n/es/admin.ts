import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Cada búsqueda y cada sugerencia van a Google Places. Desactivado, responden primero el índice de PanelMint y OpenStreetMap, y Google solo se consulta si no encuentran nada.',
  'admin.placesGoogleOnly.missingKey': 'Necesita una clave de API de Google Maps. Sin ella, la búsqueda usa el índice de PanelMint y OpenStreetMap, esté como esté este interruptor.',
  'admin.placesGoogleOnly.otherProvider': 'Necesita Google como proveedor de lugares. Con Amap u OpenStreetMap seleccionados, ninguna búsqueda va a Google, diga lo que diga este interruptor.',
  'admin.packingTemplates.items': 'artículos',
  'admin.github.support': 'Ayuda a seguir desarrollando PanelMint',
};
export default admin;
