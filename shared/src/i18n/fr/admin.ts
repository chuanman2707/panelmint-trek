import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Chaque recherche et chaque suggestion passent par Google Places. Désactivé, l\'index de PanelMint et OpenStreetMap répondent d\'abord, Google n\'est interrogé que s\'ils ne trouvent rien.',
  'admin.placesGoogleOnly.missingKey': 'Nécessite une clé API Google Maps. Sans elle, la recherche passe par l\'index de PanelMint et OpenStreetMap, quelle que soit la position de cet interrupteur.',
  'admin.placesGoogleOnly.otherProvider': 'Nécessite Google comme fournisseur de lieux. Avec Amap ou OpenStreetMap sélectionné, aucune recherche ne part vers Google, quelle que soit la position de cet interrupteur.',
  'admin.packingTemplates.items': 'articles',
  'admin.github.support': 'Aidez à poursuivre le développement de PanelMint',
};
export default admin;
