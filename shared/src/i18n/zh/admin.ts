import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': '所有搜索和建议都发送到 Google Places。关闭时，PanelMint 自有索引和 OpenStreetMap 先回答，只有二者都没有结果时才询问 Google。',
  'admin.placesGoogleOnly.missingKey': '需要 Google Maps API 密钥。没有密钥时，无论此开关如何，搜索都通过 PanelMint 索引和 OpenStreetMap 进行。',
  'admin.placesGoogleOnly.otherProvider': '需要将 Google 设为地点提供方。选择 Amap 或 OpenStreetMap 时，无论此开关如何设置，搜索都不会发送到 Google。',
  'admin.packingTemplates.items': '物品',
  'admin.github.support': '帮助我继续开发 PanelMint',
};
export default admin;
