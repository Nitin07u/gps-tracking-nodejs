import { describe, expect, it } from 'vitest';
import { getDistance, minuteToDecimal } from '../../src/lib/geo.js';

describe('minuteToDecimal', () => {
  it('converts DDMM.MMMM to decimal degrees', () => {
    expect(minuteToDecimal(3330.4288, 'S')).toBeCloseTo(-33.5071467, 6);
    expect(minuteToDecimal(7036.8518, 'W')).toBeCloseTo(-70.6141967, 6);
    expect(minuteToDecimal(2235.1777, 'N')).toBeCloseTo(22.586295, 6);
    expect(minuteToDecimal(11357.8913, 'E')).toBeCloseTo(113.964855, 6);
  });

  it('defaults to the northern/eastern hemisphere', () => {
    expect(minuteToDecimal(2235.1777)).toBeCloseTo(22.586295, 6);
  });
});

describe('getDistance', () => {
  it('measures ~0 for the same point', () => {
    expect(getDistance({ lat: -33.45, lng: -70.66 }, { lat: -33.45, lng: -70.66 })).toBe(0);
  });

  it('measures Santiago-Valparaíso at roughly 100km', () => {
    const distance = getDistance({ lat: -33.4489, lng: -70.6693 }, { lat: -33.0472, lng: -71.6127 });
    expect(distance).toBeGreaterThan(90_000);
    expect(distance).toBeLessThan(110_000);
  });
});
