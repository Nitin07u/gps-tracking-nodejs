import { describe, expect, it } from 'vitest';
import { ZxA50Adapter } from '../../src/adapters/zx-a50.js';
import { fakeDevice, sentAsStrings } from '../helpers/fake-device.js';

// Fixtures transcribed from the vendor's "Zhongxun Locator Communication
// Protocol" doc (V1.3, A50 locator), with the length byte recomputed as
// `1 (protocol) + payload.length` per the doc's own stated formula (section
// 3) rather than copied verbatim — several of the doc's own worked examples
// (0x10/0x11 in particular) show a length one less than that formula
// predicts, which looks like a transcription slip rather than a real framing
// rule (its 0x01 login example matches the formula exactly).
const LOGIN = Buffer.from('78780a010123456789012345010d0a', 'hex');
const LOGIN_ACK = '787801010d0a';
const LOGIN_FAIL_ACK = '787801440d0a';
const HEARTBEAT = Buffer.from('787801080d0a', 'hex');
const GPS = Buffer.from('787813100a03170f32179c026b3f3e0c22ad651f34600d0a', 'hex');
const GPS_ACK = '787807100a03170f32170d0a';
const GPS_OFFLINE = Buffer.from('787813110a03170f32179c026b3f3e0c22ad651f34600d0a', 'hex');
const GPS_OFFLINE_ACK = '787807110a03170f32170d0a';
const STATUS = Buffer.from('78780513552308030d0a', 'hex');
const STATUS_ACK = '78780513552308030d0a'; // doc: "reply content is the same as sending status package"
const TIME_SYNC_REQUEST = Buffer.from('787801300d0a', 'hex');

function makeAdapter(now?: () => Date) {
  const { device, sent } = fakeDevice();
  return { adapter: new ZxA50Adapter(device, now ? { now } : {}), sent };
}

describe('ZxA50Adapter', () => {
  it('parses a login request and extracts the IMEI (doc example)', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(LOGIN);
    expect(packet.action).toBe('loginRequest');
    expect(packet.deviceId).toBe('123456789012345');
  });

  it('acks an accepted login with the doc example response', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(LOGIN);
    adapter.authorize(packet);
    expect(sentAsStrings(sent)).toEqual([LOGIN_ACK]);
  });

  it('sends the doc example login-failed reply on rejectLoginFrame', () => {
    const { adapter, sent } = makeAdapter();
    adapter.rejectLoginFrame();
    expect(sentAsStrings(sent)).toEqual([LOGIN_FAIL_ACK]);
  });

  it('treats 0x08 as a heartbeat needing no ack (not in the doc mandatory-reply list)', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(HEARTBEAT);
    expect(packet.action).toBe('heartbeat');
    // BaseAdapter's default ackHeartbeat is a no-op; nothing should be sent.
    adapter.ackHeartbeat(packet);
    expect(sent).toEqual([]);
  });

  it('parses a GPS packet (0x10) per the doc example', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(GPS);
    if (packet.action !== 'ping') throw new Error('expected ping');
    // Latitude matches the doc's own worked example: 22°32.7658' = 22 + 32.7658/60.
    expect(packet.position.latitude).toBeCloseTo(22.546097, 5);
    expect(packet.position.longitude).toBeCloseTo(113.110669, 5);
    expect(packet.position.time.toISOString()).toBe('2010-03-23T15:50:23.000Z');
    expect(packet.position.valid).toBe(true);
    expect(packet.position.orientation).toBe(96);
  });

  it('acks a GPS packet with protocol number + echoed date/time', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(GPS);
    adapter.ackPing(packet);
    expect(sentAsStrings(sent)).toEqual([GPS_ACK]);
  });

  it('parses and acks offline GPS (0x11) the same way as 0x10', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(GPS_OFFLINE);
    expect(packet.cmd).toBe('11');
    if (packet.action !== 'ping') throw new Error('expected ping');
    expect(packet.position.latitude).toBeCloseTo(22.546097, 5);
    adapter.ackPing(packet);
    expect(sentAsStrings(sent)).toEqual([GPS_OFFLINE_ACK]);
  });

  it('parses a status packet (0x13) and echoes it back unchanged', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(STATUS);
    expect(packet.action).toBe('other');
    expect(packet.cmd).toBe('13');
    adapter.handleCommand(packet);
    expect(sentAsStrings(sent)).toEqual([STATUS_ACK]);
  });

  it('replies to a time-sync request (0x30) with the current UTC time', () => {
    const { adapter, sent } = makeAdapter(() => new Date('2016-07-05T05:55:24.000Z'));
    const packet = adapter.parsePacket(TIME_SYNC_REQUEST);
    expect(packet.cmd).toBe('30');
    adapter.handleCommand(packet);
    // 07E0 07 05 05 37 18 -> year 0x07E0=2016, month 07, day 05, hour 05, min 0x37=55, sec 0x18=24
    expect(sentAsStrings(sent)).toEqual(['7878083007e007050537180d0a']);
  });

  it('does not auto-reply to a settings request (0x57); sendSettings() pushes the data instead', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(Buffer.from('787801570d0a', 'hex'));
    expect(packet.cmd).toBe('57');
    adapter.handleCommand(packet);
    expect(sent).toEqual([]);

    adapter.sendSettings({
      uploadIntervalSeconds: 60,
      switches: { gps: true },
      sos: '13533333333',
    });
    const [frame] = sentAsStrings(sent);
    expect(frame?.startsWith('7878')).toBe(true);
    expect(frame?.slice(6, 8)).toBe('57');
    // upload interval 60s as 2-byte BCD (0x0060), switch byte with GPS bit set
    expect(frame?.slice(8, 12)).toBe('0060');
    expect(frame?.slice(12, 14)).toBe('01');
  });

  it('rejects frames with a corrupt tail', () => {
    const { adapter } = makeAdapter();
    const corrupted = Buffer.from(GPS);
    corrupted.writeUInt16BE(0xffff, corrupted.length - 2);
    expect(() => adapter.parsePacket(corrupted)).toThrow(/invalid frame tail/);
  });
});
