import { BaseAdapter } from './base-adapter.js';
import { LengthPrefixedFramer, type FrameMarker } from '../framing/length-prefixed-framer.js';
import type { Framer, FramerOptions } from '../framing/framer.js';
import { PacketParseError } from '../errors.js';
import { crc16X25 } from '../lib/crc.js';
import { lazyHexData, lookupAlarm, parseRmcPosition } from '../lib/protocol.js';
import type { Alarm, ParsedPacket } from '../types.js';

const TK510_FRAME_MARKERS: readonly FrameMarker[] = [
  {
    marker: Buffer.from([0x40, 0x40]),
    lengthOffset: 2,
    lengthBytes: 2,
    totalLength: (len) => len, // length field holds the total frame length
  },
];

const ALARMS: Record<string, Alarm> = {
  '01': { code: 'sos', message: 'Driver sent an S.O.S.', raw: '01' },
  '05': { code: 'alarming', message: 'The vehicle alarm was activated', raw: '05' },
  '11': { code: 'overspeed', message: 'Vehicle is over the configured maximum speed', raw: '11' },
  '13': { code: 'geofence_exit', message: 'Vehicle left the geofence', raw: '13' },
  '50': { code: 'power_off', message: 'Vehicle power off', raw: '50' },
  '71': { code: 'accident', message: 'The vehicle suffered an accident', raw: '71' },
};

/**
 * TK510 binary-framed protocol:
 * `4040 | totalLen(2) | deviceId(7 BCD, F-padded) | cmd(2) | data | crc16-x25(2) | 0d0a`
 * Commands: 0x5000 login, 0x9955 position (RMC-like ASCII payload), 0x9999 alarm.
 */
export class Tk510Adapter extends BaseAdapter {
  static override readonly protocol = 'GPSTK510';
  static override readonly modelName = 'TK510';
  static override readonly compatibleHardware = ['TK510/supplier'] as const;

  createFramer(options: FramerOptions): Framer {
    return new LengthPrefixedFramer({ markers: TK510_FRAME_MARKERS, ...options });
  }

  parsePacket(frame: Buffer): ParsedPacket {
    if (frame.length < 17 || frame.readUInt16BE(frame.length - 2) !== 0x0d0a) {
      throw new PacketParseError('TK510: invalid frame');
    }
    const crc = frame.readUInt16BE(frame.length - 4);
    const computed = crc16X25(frame.subarray(0, frame.length - 4));
    if (crc !== computed) {
      throw new PacketParseError(
        `TK510: CRC mismatch (got 0x${crc.toString(16)}, computed 0x${computed.toString(16)})`,
      );
    }

    const deviceId = frame.subarray(4, 11).toString('hex').replace(/f*$/, '');
    const cmd = frame.subarray(11, 13).toString('hex');
    const data = frame.subarray(13, frame.length - 4);
    const base = { cmd, deviceId, raw: frame };

    let packet: ParsedPacket;
    switch (cmd) {
      case '5000':
        packet = { ...base, action: 'loginRequest', deviceId };
        break;
      case '9955': {
        // RMC-like payload with protocol extras after the standard fields.
        const fields = data.toString('ascii').split(',');
        const position = parseRmcPosition(fields, 0, 'TK510');
        position.extra = {
          magneticVariation: fields[9] ?? '',
          magneticVariationDirection: fields[10] ?? '',
        };
        packet = { ...base, action: 'ping', position };
        break;
      }
      case '9999': {
        const raw = data.readUInt8(0).toString(16).padStart(2, '0');
        packet = { ...base, action: 'alarm', alarm: lookupAlarm(ALARMS, raw, 'TK510') };
        break;
      }
      default:
        packet = { ...base, action: 'other' };
    }
    return lazyHexData(packet, data);
  }

  authorize(packet: ParsedPacket): void {
    // Echo the F-padded id exactly as the device sent it in the login frame.
    this.#sendCommand(packet.raw.subarray(4, 11).toString('hex'), '4000', '01');
  }

  #sendCommand(deviceIdRaw: string, cmd: string, dataHex: string = ''): void {
    const body = Buffer.from(
      '4040' + (dataHex.length / 2 + 17).toString(16).padStart(4, '0') + deviceIdRaw + cmd + dataHex,
      'hex',
    );
    const crc = Buffer.alloc(2);
    crc.writeUInt16BE(crc16X25(body), 0);
    this.device.send(Buffer.concat([body, crc, Buffer.from([0x0d, 0x0a])]));
  }
}
