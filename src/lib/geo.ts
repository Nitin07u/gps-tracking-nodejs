/** Knots → km/h conversion factor (GPS protocols usually report speed in knots). */
export const KNOTS_TO_KMH = 1.852;

/**
 * Convert a Concox-family coordinate (unsigned integer in 1/30000 of a minute,
 * i.e. 1/500 of a second) to decimal degrees. Used by GT06/GK309/GT02A.
 */
export function minutes30000ToDegrees(value: number): number {
  return value / 30000 / 60;
}

/**
 * Convert a NMEA-style degrees+minutes value (DDMM.MMMM / DDDMM.MMMM)
 * to decimal degrees. Negative for southern/western hemispheres.
 * Returns NaN for malformed input (minutes >= 60, out-of-range degrees,
 * unknown hemisphere) so parsers reject it instead of emitting a bogus fix.
 */
export function minuteToDecimal(value: number, hemisphere: string = 'N'): number {
  const degrees = Math.floor(value / 100);
  const minutes = value - degrees * 100;
  const h = hemisphere.toUpperCase();
  const maxDegrees = h === 'E' || h === 'W' ? 180 : h === 'N' || h === 'S' ? 90 : Number.NaN;
  if (!Number.isFinite(value) || degrees < 0 || !(degrees <= maxDegrees) || minutes >= 60) {
    return Number.NaN;
  }
  const decimal = degrees + minutes / 60;
  return h === 'S' || h === 'W' ? -decimal : decimal;
}

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6378137;

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine distance between two points, in meters. */
export function getDistance(p1: LatLng, p2: LatLng): number {
  const dLat = rad(p2.lat - p1.lat);
  const dLng = rad(p2.lng - p1.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rad(p1.lat)) * Math.cos(rad(p2.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
