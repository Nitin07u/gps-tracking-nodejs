import { describe, expect, it } from 'vitest';
import { St901Adapter } from '../../src/adapters/st901.js';
import { fakeDevice, sentAsStrings } from '../helpers/fake-device.js';

// Real packets from the Traccar H02 protocol test suite and the HuaSunTeK spec.
const V1_FULL = Buffer.from(
  '*HQ,4970105243,V1,104000,A,2235.1777,N,11357.8913,E,000.27,235,130721,FFFFFBFF,460,11,d18e105,7752,6#',
);
const V1_SPACES = Buffer.from('*HQ,865205035331981,V1,132926,A,1935.3933,N,07920.4134,E,  3.34,342,280519,FFFFFFFF#');
const HTBT = Buffer.from('*HQ,135790246811220,HTBT,100#');
const ALRM_SOS = Buffer.from('*HQ,4970105243,ALRM,1,104000,A,2235.1777,N,11357.8913,E,000.00,000,130721#');

function makeAdapter() {
  const { device, sent } = fakeDevice();
  return { adapter: new St901Adapter(device), sent };
}

describe('St901Adapter (H02)', () => {
  it('does not require a login handshake', () => {
    expect(St901Adapter.requiresLogin).toBe(false);
  });

  it('parses a V1 position message (Traccar fixture)', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(V1_FULL);
    if (packet.action !== 'ping') throw new Error('expected ping');
    expect(packet.deviceId).toBe('4970105243');
    expect(packet.position.latitude).toBeCloseTo(22.586295, 6);
    expect(packet.position.longitude).toBeCloseTo(113.964855, 6);
    expect(packet.position.time.toISOString()).toBe('2021-07-13T10:40:00.000Z');
    expect(packet.position.speed).toBeCloseTo(0.27 * 1.852, 4);
    expect(packet.position.orientation).toBe(235);
    expect(packet.position.valid).toBe(true);
    // status FFFFFBFF → bit10 = 0 → ACC/ignition off
    expect(packet.position.extra?.ignition).toBe(false);
  });

  it('tolerates space-padded fields and 15-digit IMEIs', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(V1_SPACES);
    if (packet.action !== 'ping') throw new Error('expected ping');
    expect(packet.deviceId).toBe('865205035331981');
    expect(packet.position.latitude).toBeCloseTo(19.589888, 5);
    expect(packet.position.longitude).toBeCloseTo(79.340223, 5);
    expect(packet.position.speed).toBeCloseTo(3.34 * 1.852, 4);
    expect(packet.position.time.toISOString()).toBe('2019-05-28T13:29:26.000Z');
    // status FFFFFFFF → bit10 = 1 → ignition on
    expect(packet.position.extra?.ignition).toBe(true);
  });

  it('echoes HTBT heartbeats (required by newer ST-901 firmwares)', () => {
    const { adapter, sent } = makeAdapter();
    const packet = adapter.parsePacket(HTBT);
    expect(packet.action).toBe('heartbeat');
    adapter.ackHeartbeat(packet);
    expect(sentAsStrings(sent)).toEqual(['*HQ,135790246811220,HTBT#']);
  });

  it('parses ALRM alarm messages', () => {
    const { adapter } = makeAdapter();
    const packet = adapter.parsePacket(ALRM_SOS);
    if (packet.action !== 'alarm') throw new Error('expected alarm');
    expect(packet.alarm.code).toBe('sos');
  });

  it('ignores V4 command echoes', () => {
    const { adapter } = makeAdapter();
    expect(adapter.parsePacket(Buffer.from('*HQ,4970105243,V4,V1,20210713104000#')).action).toBe('ignore');
  });
});
