import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'すべての検索と候補が Google Places に送られます。オフの場合は PanelMint のインデックスと OpenStreetMap が先に答え、何も見つからないときだけ Google に問い合わせます。',
  'admin.placesGoogleOnly.missingKey': 'Google Maps API キーが必要です。キーがない場合、このスイッチに関係なく検索は PanelMint のインデックスと OpenStreetMap で行われます。',
  'admin.placesGoogleOnly.otherProvider': '場所プロバイダーとして Google が必要です。Amap または OpenStreetMap を選択している間は、このスイッチの状態にかかわらず検索は Google に送られません。',
  'admin.packingTemplates.items': 'アイテム',
  'admin.github.support': 'PanelMintの開発を支援',
};
export default admin;
