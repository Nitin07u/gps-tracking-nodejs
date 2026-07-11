import { describe, expect, it } from 'vitest';
import { Tk103Adapter } from '../../src/adapters/tk103.js';
import { fakeDevice, sentAsStrings } from '../helpers/fake-device.js';

// Packet examples from the original protocol docs / v1 readme.
const LOGIN = Buffer.from(
  '(012341234123BP05000012341234123140607A3330.4288S07036.8518W019.2230104172.3900000000L00019C2C)',
);
const PING = Buffer.from(
  '(012341234123BR00140607A3330.4288S07036.8518W019.2230104172.3900000000L00019C2C)',
);
const ALARM = Buffer.from(
  '(012341234123BO012140607A3330.4288S07036.8518W019.2230104172.3900000000L00019C2C)',
);
const HANDSHAKE = Buffer.from('(012341234123BP00HSO)');

function makeAdapter(id = '012341234123') {
  const { device, sent } = fakeDevice(id);
  return { adapter: new Tk103Adapter(device), sent };
}

describe('Tk103Adapter', () => {
  it('parses a login request (BP05)', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(LOGIN);
    expect(packet.action).toBe('loginRequest');
    expect(packet.deviceId).toBe('012341234123');
    expect(packet.cmd).toBe('BP05');
  });

  it('acknowledges an accepted login with AP05', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(LOGIN);
    adapter.authorize(packet);
    expect(sentAsStrings(sent)).toEqual(['(012341234123AP05)']);
  });

  it('parses a position packet (BR00)', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(PING);
    if (packet.action !== 'ping') throw new Error('expected ping');
    expect(packet.position.latitude).toBeCloseTo(-33.5071467, 6);
    expect(packet.position.longitude).toBeCloseTo(-70.6141967, 6);
    expect(packet.position.speed).toBeCloseTo(19.2);
    expect(packet.position.orientation).toBeCloseTo(172.39);
    expect(packet.position.valid).toBe(true);
    expect(packet.position.mileage).toBe(Number.parseInt('00019C2C', 16));
    expect(packet.position.time.toISOString()).toBe('2014-06-07T23:01:04.000Z');
  });

  it('parses an alarm packet (BO01) with its position and acks it', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(ALARM);
    if (packet.action !== 'alarm') throw new Error('expected alarm');
    expect(packet.alarm.code).toBe('sos');
    expect(packet.position?.latitude).toBeCloseTo(-33.5071467, 6);
    adapter.ackAlarm(packet);
    expect(sentAsStrings(sent)).toEqual(['(012341234123AS012)']);
  });

  it('replies to the BP00 handshake', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(HANDSHAKE);
    expect(packet.action).toBe('other');
    adapter.handleCommand(packet);
    expect(sentAsStrings(sent)).toEqual(['(012341234123AP01HSO)']);
  });

  it('rejects frames without a command', () => {
    const { adapter } = makeAdapter();
    expect(() => adapter.parsePacket(Buffer.from('(garbage-without-cmd)'))).toThrow();
  });

  it('encodes setRefreshInterval as AR00', () => {
    const { adapter, sent } = makeAdapter();
    adapter.setRefreshInterval(30, 3660);
    expect(sentAsStrings(sent)).toEqual(['(012341234123AR00001e0101)']);
  });
});
