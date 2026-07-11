import { describe, expect, it } from 'vitest';
import { crc16X25 } from '../../src/lib/crc.js';

describe('crc16X25', () => {
  it('matches the standard X-25 check value', () => {
    expect(crc16X25(Buffer.from('123456789', 'ascii'))).toBe(0x906e);
  });

  it('matches the GT06/GK309 login response example from the official Concox doc', () => {
    // Response 78 78 05 01 00 01 D9 DC 0D 0A → CRC over 05 01 00 01 = 0xD9DC
    expect(crc16X25(Buffer.from('05010001', 'hex'))).toBe(0xd9dc);
  });

  it('matches the GK309 GPS packet example from the official Concox doc', () => {
    expect(crc16X25(Buffer.from('19100B03110A100FCF027AC8570C4657350014000001000452830D0A'.slice(0, -8), 'hex'))).toBe(
      0x5283,
    );
  });

  it('matches the GK309 GPS ack example from the official Concox doc', () => {
    expect(crc16X25(Buffer.from('05100004', 'hex'))).toBe(0x5138);
  });
});
