import { BaseAdapter } from './base-adapter.js';
import { LengthPrefixedFramer, type FrameMarker } from '../framing/length-prefixed-framer.js';
import type { Framer, FramerOptions } from '../framing/framer.js';
import { GT06_FRAME_MARKERS } from './gt06.js';
import { PacketParseError } from '../errors.js';
import { minutes30000ToDegrees } from '../lib/geo.js';
import { bcdImei, binaryDate, lazyHexData } from '../lib/protocol.js';
import type { GpsPosition, ParsedPacket } from '../types.js';

// GT02A frames plus the Concox 7878/7979 service frames some units also emit.
const GT02A_FRAME_MARKERS: readonly FrameMarker[] = [
  {
    marker: Buffer.from([0x68, 0x68]),
    lengthOffset: 2,
    lengthBytes: 1,
    totalLength: (len) => len + 5,
  },
  ...GT06_FRAME_MARKERS,
];

/**
 * GT02A binary protocol:
 * `6868 | len | power | gsm | deviceId(8 BCD) | count(2) | proto | data | 0d0a`
 * Login proto 0x1a, position proto 0x10. Login ack: `54 68 1a 0d 0a` ("Th" + 0x1a + CRLF).
 */
export class Gt02aAdapter extends BaseAdapter {
  static override readonly protocol = 'GT02A';
  static override readonly modelName = 'GT02A';
  static override readonly compatibleHardware = ['GT02A/supplier'] as const;

  createFramer(options: FramerOptions): Framer {
    return new LengthPrefixedFramer({ markers: GT02A_FRAME_MARKERS, ...options });
  }

  parsePacket(frame: Buffer): ParsedPacket {
    if (frame.length < 5 || frame.readUInt16BE(frame.length - 2) !== 0x0d0a) {
      throw new PacketParseError('GT02A: invalid frame tail');
    }

    if (frame.readUInt16BE(0) !== 0x6868) {
      // 0x7878/0x7979 service frames (clock sync etc.): nothing to do.
      return { cmd: frame.subarray(3, 4).toString('hex'), raw: frame, action: 'ignore' };
    }
    if (frame.length < 18) {
      throw new PacketParseError('GT02A: frame too short');
    }

    const deviceId = bcdImei(frame.subarray(5, 13));
    const proto = frame.readUInt8(15);
    const data = frame.subarray(16, frame.length - 2);
    const base = {
      cmd: proto.toString(16).padStart(2, '0'),
      deviceId,
      raw: frame,
      serial: frame.readUInt16BE(13),
    };

    let packet: ParsedPacket;
    switch (proto) {
      case 0x1a:
        packet = { ...base, action: 'loginRequest', deviceId };
        break;
      case 0x10:
        packet = { ...base, action: 'ping', position: this.#parsePosition(data, frame) };
        break;
      default:
        packet = { ...base, action: 'other' };
    }
    return lazyHexData(packet, data);
  }

  authorize(): void {
    this.device.send(Buffer.from([0x54, 0x68, 0x1a, 0x0d, 0x0a]));
  }

  // date(6) + lat(4) + lon(4) + speed(1) + course(2)
  #parsePosition(data: Buffer, frame: Buffer): GpsPosition {
    if (data.length < 17) {
      throw new PacketParseError('GT02A: position content too short');
    }
    return {
      // GT02A does not transmit hemisphere information; coordinates come unsigned.
      latitude: minutes30000ToDegrees(data.readUInt32BE(6)),
      longitude: minutes30000ToDegrees(data.readUInt32BE(10)),
      time: binaryDate(data),
      speed: data.readUInt8(14),
      orientation: data.readUInt16BE(15),
      extra: {
        power: frame.readUInt8(3),
        gsmSignal: frame.readUInt8(4),
      },
    };
  }
}
