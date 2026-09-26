import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'كل بحث وكل اقتراح يذهب إلى Google Places. عند الإيقاف يجيب فهرس PanelMint وOpenStreetMap أولًا، ولا يُسأل Google إلا إذا لم يجدا شيئًا.',
  'admin.placesGoogleOnly.missingKey': 'يتطلب مفتاح Google Maps API. من دونه يعمل البحث عبر فهرس PanelMint وOpenStreetMap مهما كان وضع هذا المفتاح.',
  'admin.placesGoogleOnly.otherProvider': 'يتطلب Google كمزود للأماكن. عند اختيار Amap أو OpenStreetMap لا يذهب أي بحث إلى Google مهما كان وضع هذا المفتاح.',
  'admin.packingTemplates.items': 'عناصر',
  'admin.github.support': 'يساعدني في تطوير PanelMint',
};
export default admin;
