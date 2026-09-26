import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Setiap pencarian dan setiap saran dikirim ke Google Places. Nonaktif, indeks PanelMint dan OpenStreetMap menjawab lebih dulu, dan Google hanya ditanya jika keduanya tidak menemukan apa pun.',
  'admin.placesGoogleOnly.missingKey': 'Memerlukan kunci API Google Maps. Tanpa kunci, pencarian memakai indeks PanelMint dan OpenStreetMap, apa pun posisi sakelar ini.',
  'admin.placesGoogleOnly.otherProvider': 'Membutuhkan Google sebagai penyedia tempat. Dengan Amap atau OpenStreetMap yang dipilih, tidak ada pencarian yang dikirim ke Google, apa pun posisi sakelar ini.',
  'admin.packingTemplates.items': 'item',
  'admin.github.support': 'Bantu saya terus mengembangkan PanelMint',
};
export default admin;
