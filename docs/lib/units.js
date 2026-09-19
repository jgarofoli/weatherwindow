// Display-only conversions. Canonical storage is °C, km/h, mm; never round here.
const KMH_PER_MPH = 1.609344;
const MM_PER_IN = 25.4;

export const cToF = (c) => (c * 9) / 5 + 32;
export const fToC = (f) => ((f - 32) * 5) / 9;
export const kmhToMph = (k) => k / KMH_PER_MPH;
export const mphToKmh = (m) => m * KMH_PER_MPH;
export const mmToIn = (mm) => mm / MM_PER_IN;
export const inToMm = (i) => i * MM_PER_IN;
