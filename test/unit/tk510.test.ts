import { describe, expect, it } from 'vitest';
import { Tk510Adapter } from '../../src/adapters/tk510.js';
import { crc16X25 } from '../../src/lib/crc.js';
import { fakeDevice, sentAsStrings } from '../helpers/fake-device.js';

const DEVICE_ID_RAW = '0135790246811f'; // 7 BCD bytes, F-padded

/** Build a TK510 frame: 4040 | totalLen(2) | id(7) | cmd(2) | data | crc(2) | 0d0a */
function buildFrame(cmd: string, data: Buffer): Buffer {
  const total = data.length + 17;
  const body = Buffer.concat([
    Buffer.from('4040' + total.toString(16).padStart(4, '0') + DEVICE_ID_RAW + cmd, 'hex'),
    data,
  ]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16BE(crc16X25(body), 0);
  return Buffer.concat([body, crc, Buffer.from([0x0d, 0x0a])]);
}

const LOGIN = buildFrame('5000', Buffer.alloc(0));
const PING = buildFrame('9955', Buffer.from('052825,A,2239.4210,N,11400.8825,E,0.00,348,180814,0.0,E,7A', 'ascii'));
const ALARM = buildFrame('9999', Buffer.from('01', 'hex'));

function makeAdapter() {
  const { device, sent } = fakeDevice();
  return { adapter: new Tk510Adapter(device), sent };
}

describe('Tk510Adapter', () => {
  it('parses a login request (0x5000) stripping the F padding from the id', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(LOGIN);
    expect(packet.action).toBe('loginRequest');
    expect(packet.deviceId).toBe('0135790246811');
  });

  it('acks an accepted login with 0x4000 + 01, CRC included', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(LOGIN);
    adapter.authorize(packet);
    const [ack] = sentAsStrings(sent);
    expect(ack).toMatch(new RegExp(`^40400012${DEVICE_ID_RAW}400001[0-9a-f]{4}0d0a$`));
    // The ack must carry a valid CRC over everything before it.
    const buffer = Buffer.from(ack!, 'hex');
    expect(buffer.readUInt16BE(buffer.length - 4)).toBe(crc16X25(buffer.subarray(0, buffer.length - 4)));
  });

  it('parses a position packet (0x9955) with an RMC-like payload', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(PING);
    if (packet.action !== 'ping') throw new Error('expected ping');
    expect(packet.position.latitude).toBeCloseTo(22.657017, 5);
    expect(packet.position.longitude).toBeCloseTo(114.014708, 5);
    expect(packet.position.speed).toBe(0);
    expect(packet.position.orientation).toBe(348);
    // RMC date is DDMMYY: 180814 = 2014-08-18 (v1 misread it as YYMMDD).
    expect(packet.position.time.toISOString()).toBe('2014-08-18T05:28:25.000Z');
    expect(packet.position.valid).toBe(true);
  });

  it('parses alarm packets (0x9999)', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(ALARM);
    if (packet.action !== 'alarm') throw new Error('expected alarm');
    expect(packet.alarm.code).toBe('sos');
  });

  it('rejects frames with a bad CRC', () => {
    const { adapter } = makeAdapter();
    const corrupted = Buffer.from(PING);
    corrupted.writeUInt8(corrupted.readUInt8(20) ^ 0xff, 20);
    expect(() => adapter.parsePacket(corrupted)).toThrow(/CRC/);
  });
});
