import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Toda pesquisa e toda sugestão vão para o Google Places. Desligado, o índice do PanelMint e o OpenStreetMap respondem primeiro, e o Google só é consultado se eles não encontrarem nada.',
  'admin.placesGoogleOnly.missingKey': 'Precisa de uma chave de API do Google Maps. Sem ela, a pesquisa usa o índice do PanelMint e o OpenStreetMap, independentemente desta chave.',
  'admin.placesGoogleOnly.otherProvider': 'Precisa do Google como provedor de lugares. Com Amap ou OpenStreetMap selecionado, nenhuma busca vai ao Google, seja qual for a posição deste botão.',
  'admin.packingTemplates.items': 'itens',
  'admin.github.support': 'Ajuda a continuar desenvolvendo o PanelMint',
};
export default admin;
