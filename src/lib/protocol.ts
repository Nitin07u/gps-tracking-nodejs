/**
 * Shared protocol-parsing utilities used by the built-in adapters.
 */
import { PacketParseError } from '../errors.js';
import { KNOTS_TO_KMH, minuteToDecimal } from './geo.js';
import type { Alarm, GpsPosition } from '../types.js';

/** Build a UTC Date from date/time components (2-digit year). */
export function utcDate(
  yy: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
): Date {
  return new Date(Date.UTC(2000 + yy, month - 1, day, hours, minutes, seconds));
}

/** Parse a pair of ASCII digits from a string at the given offset. */
export function digits2(str: string, offset: number): number {
  return Number.parseInt(str.slice(offset, offset + 2), 10);
}

/** RMC-style DDMMYY date + HHMMSS time → UTC Date. */
export function rmcDate(ddmmyy: string, hhmmss: string): Date {
  return utcDate(
    digits2(ddmmyy, 4),
    digits2(ddmmyy, 2),
    digits2(ddmmyy, 0),
    digits2(hhmmss, 0),
    digits2(hhmmss, 2),
    digits2(hhmmss, 4),
  );
}

/** Six binary bytes YY MM DD HH mm ss (UTC), as used by the Concox family. */
export function binaryDate(data: Buffer, offset = 0): Date {
  return utcDate(
    data.readUInt8(offset),
    data.readUInt8(offset + 1),
    data.readUInt8(offset + 2),
    data.readUInt8(offset + 3),
    data.readUInt8(offset + 4),
    data.readUInt8(offset + 5),
  );
}

/** 8 BCD bytes = 16 digits = a 15-digit IMEI with a leading zero. */
export function bcdImei(bytes: Buffer): string {
  return bytes.toString('hex').replace(/^0/, '');
}

/**
 * Parse RMC-like comma-separated position fields starting at `offset`:
 * time(HHMMSS), validity(A/V), lat(DDMM.MMMM), N/S, lon(DDDMM.MMMM), E/W,
 * speed(knots), course, date(DDMMYY). Returns the protocol-agnostic core;
 * adapters layer their protocol-specific `extra` on top.
 */
export function parseRmcPosition(fields: string[], offset: number, context: string): GpsPosition {
  if (fields.length < offset + 9) {
    throw new PacketParseError(`${context}: position payload too short: ${fields.join(',')}`);
  }
  const field = (index: number) => (fields[offset + index] ?? '').trim();
  const latitude = minuteToDecimal(Number.parseFloat(field(2)), field(3) || 'N');
  const longitude = minuteToDecimal(Number.parseFloat(field(4)), field(5) || 'E');
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    throw new PacketParseError(`${context}: invalid coordinates in payload: ${fields.join(',')}`);
  }
  const course = field(7);
  return {
    latitude,
    longitude,
    time: rmcDate(field(8), field(0)),
    valid: field(1) === 'A',
    speed: Number.parseFloat(field(6) || '0') * KNOTS_TO_KMH,
    orientation: course === '' ? 0 : Number.parseFloat(course),
  };
}

/** Look up a protocol alarm code, synthesizing a consistent unknown-alarm shape. */
export function lookupAlarm(table: Record<string, Alarm>, raw: string, protocol: string): Alarm {
  return table[raw] ?? { code: `alarm_${raw}`, message: `Unknown ${protocol} alarm ${raw}`, raw };
}

/**
 * Attach `data` to a packet as a lazy, cached hex encoding of `content`.
 * Binary payloads are only hex-encoded if someone actually reads `.data`.
 */
export function lazyHexData<T extends { data?: string }>(packet: T, content: Buffer): T {
  return Object.defineProperty(packet, 'data', {
    enumerable: true,
    configurable: true,
    get(): string {
      const value = content.toString('hex');
      Object.defineProperty(packet, 'data', { value, enumerable: true, configurable: true, writable: true });
      return value;
    },
  });
}
