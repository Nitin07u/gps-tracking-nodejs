// 256-entry lookup table, built once at module load (~0.5 KB).
const TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  TABLE[i] = crc;
}

/**
 * CRC-16/X-25 (also known as CRC-ITU): reflected polynomial 0x8408,
 * init 0xFFFF, final XOR 0xFFFF. Used by the Concox GT06/GK309 family
 * and by TK510 frames. Identical output to the old `crc16-ccitt-node`
 * and `crc-itu` dependencies this package used in v1.
 */
export function crc16X25(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return ~crc & 0xffff;
}
