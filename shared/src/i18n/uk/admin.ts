import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Кожен пошук і кожна підказка йдуть до Google Places. Вимкнено: спершу відповідають індекс PanelMint та OpenStreetMap, Google запитується лише тоді, коли вони нічого не знайшли.',
  'admin.placesGoogleOnly.missingKey': 'Потрібен ключ Google Maps API. Без нього пошук іде через індекс PanelMint та OpenStreetMap незалежно від цього перемикача.',
  'admin.placesGoogleOnly.otherProvider': 'Потрібен Google як постачальник місць. Якщо вибрано Amap або OpenStreetMap, жоден пошук не йде до Google, хай як стоїть цей перемикач.',
  'admin.packingTemplates.items': 'речей',
  'admin.github.support': 'Допомагає продовжувати розробку PanelMint',
};
export default admin;
