import type { TranslationStrings } from '../types';

const admin: TranslationStrings = {
  'admin.placesGoogleOnly.subtitle': 'Κάθε αναζήτηση και κάθε πρόταση πηγαίνει στο Google Places. Απενεργοποιημένο, απαντούν πρώτα το ευρετήριο του PanelMint και το OpenStreetMap, και το Google ρωτιέται μόνο αν δεν βρουν τίποτα.',
  'admin.placesGoogleOnly.missingKey': 'Χρειάζεται κλειδί Google Maps API. Χωρίς αυτό η αναζήτηση τρέχει στο ευρετήριο του PanelMint και στο OpenStreetMap, όπως κι αν είναι ο διακόπτης.',
  'admin.placesGoogleOnly.otherProvider': 'Χρειάζεται το Google ως πάροχο τοποθεσιών. Με επιλεγμένο Amap ή OpenStreetMap καμία αναζήτηση δεν πηγαίνει στο Google, ό,τι κι αν λέει αυτός ο διακόπτης.',
  'admin.packingTemplates.items': 'αντικείμενα',
  'admin.github.support': 'Βοηθά να συνεχίσω την ανάπτυξη του PanelMint',
};
export default admin;
