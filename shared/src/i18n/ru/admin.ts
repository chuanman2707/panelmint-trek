import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Каждый поиск и каждая подсказка идут в Google Places. Выключено: сначала отвечают индекс PanelMint и OpenStreetMap, Google спрашивается, только если они ничего не нашли.',
  'admin.placesGoogleOnly.missingKey': 'Нужен ключ Google Maps API. Без него поиск идёт через индекс PanelMint и OpenStreetMap независимо от этого переключателя.',
  'admin.placesGoogleOnly.otherProvider': 'Требуется Google как провайдер мест. Если выбран Amap или OpenStreetMap, ни один поиск не уходит в Google, как бы ни стоял этот переключатель.',
  'admin.packingTemplates.items': 'вещей',
  'admin.github.support': 'Помогает продолжать разработку PanelMint',
};
export default admin;
