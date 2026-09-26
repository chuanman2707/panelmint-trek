import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': '所有搜尋和建議都會送到 Google Places。關閉時，PanelMint 自有索引和 OpenStreetMap 先回答，只有兩者都沒有結果時才詢問 Google。',
  'admin.placesGoogleOnly.missingKey': '需要 Google Maps API 金鑰。沒有金鑰時，無論此開關如何，搜尋都透過 PanelMint 索引和 OpenStreetMap 進行。',
  'admin.placesGoogleOnly.otherProvider': '需要將 Google 設為地點提供者。選擇 Amap 或 OpenStreetMap 時，無論此開關如何設定，搜尋都不會送往 Google。',
  'admin.packingTemplates.items': '物品',
  'admin.github.support': '幫助我繼續開發 PanelMint',
};
export default admin;
