/**
 * Shared protocol-parsing utilities used by the built-in adapters.
 */
import { PacketParseError } from '../errors.js';
import { KNOTS_TO_KMH, minuteToDecimal } from './geo.js';
import type { Alarm, GpsPosition } from '../types.js';

/**
 * Build a UTC Date from date/time components (2-digit year).
 * Throws PacketParseError on non-integer or overflowing components
 * (Date.UTC would silently normalize e.g. month 13 into the next year).
 */
export function utcDate(
  yy: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
): Date {
  const values = [yy, month, day, hours, minutes, seconds];
  if (!values.every(Number.isInteger) || yy < 0 || yy > 99) {
    throw new PacketParseError('invalid date components');
  }
  const date = new Date(Date.UTC(2000 + yy, month - 1, day, hours, minutes, seconds));
  if (
    date.getUTCFullYear() !== 2000 + yy ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hours ||
    date.getUTCMinutes() !== minutes ||
    date.getUTCSeconds() !== seconds
  ) {
    throw new PacketParseError('invalid date components');
  }
  return date;
}

/** Parse a pair of ASCII digits from a string at the given offset. NaN if not two digits. */
export function digits2(str: string, offset: number): number {
  const pair = str.slice(offset, offset + 2);
  return /^\d{2}$/.test(pair) ? Number(pair) : Number.NaN;
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

/**
 * Inverse of binaryDate: encode a UTC Date as six raw bytes YY MM DD HH mm ss
 * (each byte the plain numeric value, not packed BCD), as used by the Concox
 * GT06 family and most of its clones for position/status timestamps.
 */
export function toBinaryDate(date: Date): Buffer {
  const buf = Buffer.alloc(6);
  buf.writeUInt8(date.getUTCFullYear() - 2000, 0);
  buf.writeUInt8(date.getUTCMonth() + 1, 1);
  buf.writeUInt8(date.getUTCDate(), 2);
  buf.writeUInt8(date.getUTCHours(), 3);
  buf.writeUInt8(date.getUTCMinutes(), 4);
  buf.writeUInt8(date.getUTCSeconds(), 5);
  return buf;
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
