import { describe, expect, it } from 'vitest';
import { Gt06Adapter, Gk309Adapter } from '../../src/adapters/gt06.js';
import { fakeDevice, sentAsStrings } from '../helpers/fake-device.js';

// All fixtures come from Appendix B of the official Concox "GK309 Communication
// Protocol V1.8" PDF (attached to issue #26), which is the GT06 wire protocol.
const LOGIN = Buffer.from('78780F01025241903071152410050001F3D70D0A', 'hex');
const LOGIN_ACK = '787805010001d9dc0d0a';
const GPS = Buffer.from('787819100B03110A100FCF027AC8570C4657350014000001000452830D0A', 'hex');
const GPS_ACK = '78780510000451380d0a';
const HEARTBEAT = Buffer.from('78780A13000504000003F352940D0A', 'hex');
const HEARTBEAT_ACK = '7878051303f317040d0a';
const SOS_ALARM = Buffer.from(
  '787825160B03110A1010CF027AC8450C4657410014000901CC00266A001E236006040001000A34620D0A',
  'hex',
);

function makeAdapter() {
  const { device, sent } = fakeDevice();
  return { adapter: new Gt06Adapter(device), sent };
}

describe('Gt06Adapter', () => {
  it('parses a login request and extracts the IMEI', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(LOGIN);
    expect(packet.action).toBe('loginRequest');
    expect(packet.deviceId).toBe('252419030711524');
    expect(packet.serial).toBe(1);
  });

  it('acks an accepted login echoing the received serial (doc example)', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(LOGIN);
    adapter.authorize(packet);
    expect(sentAsStrings(sent)).toEqual([LOGIN_ACK]);
  });

  it('parses a GPS packet (0x10) per the doc example', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(GPS);
    if (packet.action !== 'ping') throw new Error('expected ping');
    expect(packet.position.latitude).toBeCloseTo(23.111728, 5);
    expect(packet.position.longitude).toBeCloseTo(114.409131, 5);
    expect(packet.position.time.toISOString()).toBe('2011-03-17T10:16:15.000Z');
    expect(packet.position.satellites).toBe(15);
    expect(packet.position.speed).toBe(0);
    expect(packet.position.orientation).toBe(0);
    expect(packet.position.valid).toBe(true);
    expect(packet.serial).toBe(4);
  });

  it('acks a GPS packet with the doc example response', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(GPS);
    adapter.ackPing(packet);
    expect(sentAsStrings(sent)).toEqual([GPS_ACK]);
  });

  it('parses and acks a heartbeat (0x13) with the doc example response', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(HEARTBEAT);
    expect(packet.action).toBe('heartbeat');
    adapter.ackHeartbeat(packet);
    expect(sentAsStrings(sent)).toEqual([HEARTBEAT_ACK]);
  });

  it('detects the SOS alarm from the terminal-info byte (0x16)', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(SOS_ALARM);
    if (packet.action !== 'alarm') throw new Error('expected alarm');
    expect(packet.alarm.code).toBe('sos');
    expect(packet.position?.latitude).toBeCloseTo(23.111718, 5);
    expect(packet.position?.extra?.mcc).toBe(460);
    expect(packet.position?.extra?.voltage).toBe(6);
    expect(packet.position?.extra?.gsmSignal).toBe(4);
  });

  it('rejects frames with a bad CRC', () => {
    const { adapter } = makeAdapter();
    const corrupted = Buffer.from(GPS);
    corrupted.writeUInt8(corrupted.readUInt8(10) ^ 0xff, 10);
    expect(() => adapter.parsePacket(corrupted)).toThrow(/CRC/);
  });

  it('GK309 uses the same protocol under its own model name', () => {
    const { device } = fakeDevice();
    const adapter = new Gk309Adapter(device);
    expect(Gk309Adapter.modelName).toBe('GK309');
    expect(adapter.parsePacket(LOGIN).deviceId).toBe('252419030711524');
  });
});
