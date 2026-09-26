import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': '모든 검색과 제안이 Google Places로 갑니다. 끄면 PanelMint 자체 색인과 OpenStreetMap이 먼저 답하고, 둘 다 찾지 못할 때만 Google에 묻습니다.',
  'admin.placesGoogleOnly.missingKey': 'Google Maps API 키가 필요합니다. 키가 없으면 이 스위치와 상관없이 PanelMint 색인과 OpenStreetMap으로 검색합니다.',
  'admin.placesGoogleOnly.otherProvider': '장소 제공자로 Google이 필요합니다. Amap 또는 OpenStreetMap을 선택한 동안에는 이 스위치와 상관없이 검색이 Google로 가지 않습니다.',
  'admin.packingTemplates.items': '항목',
  'admin.github.support': 'PanelMint 개발 지속에 도움이 됩니다',
};
export default admin;
