import { describe, expect, it } from 'vitest';
import { Gt02aAdapter } from '../../src/adapters/gt02a.js';
import { fakeDevice, sentAsStrings } from '../helpers/fake-device.js';

// Fixtures built from the GT02 protocol spec (same position payload as the
// Concox doc example: 2011-03-17 10:16:15, 23.111728N 114.409131E).
const LOGIN = Buffer.from('68680D040401234567890123450001' + '1A' + '0D0A', 'hex');
const PING = Buffer.from(
  '68681E0404012345678901234500011' + '0' + '0B03110A100F' + '027AC857' + '0C465735' + '35' + '0014' + '0D0A',
  'hex',
);

function makeAdapter() {
  const { device, sent } = fakeDevice();
  return { adapter: new Gt02aAdapter(device), sent };
}

describe('Gt02aAdapter', () => {
  it('parses a login request (0x1a) and extracts the IMEI', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(LOGIN);
    expect(packet.action).toBe('loginRequest');
    expect(packet.deviceId).toBe('123456789012345');
  });

  it('acks an accepted login with Th+0x1a', () => {
    const { adapter, sent } = makeAdapter();
    adapter.parsePacket(LOGIN);
    adapter.authorize();
    expect(sentAsStrings(sent)).toEqual(['54681a0d0a']);
  });

  it('parses a position packet (0x10)', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(PING);
    if (packet.action !== 'ping') throw new Error('expected ping');
    expect(packet.position.latitude).toBeCloseTo(23.111728, 5);
    expect(packet.position.longitude).toBeCloseTo(114.409131, 5);
    expect(packet.position.speed).toBe(0x35);
    expect(packet.position.orientation).toBe(20);
    expect(packet.position.time.toISOString()).toBe('2011-03-17T10:16:15.000Z');
    expect(packet.position.extra?.power).toBe(4);
  });

  it('ignores 0x7878 service frames', () => {
    const { adapter } = makeAdapter();
    const clock = Buffer.from('787805 8A 0001 D9DC 0D0A'.replaceAll(' ', ''), 'hex');
    expect(adapter.parsePacket(clock).action).toBe('ignore');
  });
});
