import { roundTo } from "./units.js";

// M3 provides roundCoord (urlstate needs it); buildGeocodeUrl/normalizeGeocode arrive in M6.
export const roundCoord = (x, decimals = 2) => roundTo(x, decimals);
