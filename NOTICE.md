# Third-party data & attributions

PanelMint uses third-party data that requires attribution.

## OpenStreetMap — geocoding, place details & descriptions

Place search, details and descriptions come from the **Nominatim** service
and **Overpass**, and Nominatim reverse-geocodes map clicks into place names.
Data is © OpenStreetMap contributors, licensed under the Open Database
License (ODbL). https://www.openstreetmap.org/copyright

## Wikimedia Commons & Wikipedia — place pictures & descriptions

Pictures offered for a place come from **Wikimedia Commons** (geosearch by
coordinate) and are cached locally rather than hotlinked. Descriptions can come
from **Wikipedia**, resolved from the place's OpenStreetMap `wikipedia` tag.

Commons files carry their own licence, most often **CC BY** or **CC BY-SA**.
PanelMint shows the author, the licence and a link to the file description page
next to every picture while it is being chosen, and keeps the author and licence
with the cached file so the credit stays visible afterwards. Wikipedia article
text is **CC BY-SA 4.0**. https://commons.wikimedia.org/wiki/Commons:Licensing

## OurAirports — airport reference data

`client/src/data/airports.json` is built from **OurAirports**
(https://ourairports.com/data/), released into the public domain.
