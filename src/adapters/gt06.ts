import { BaseAdapter } from './base-adapter.js';
import { LengthPrefixedFramer, type FrameMarker } from '../framing/length-prefixed-framer.js';
import type { Framer, FramerOptions } from '../framing/framer.js';
import { PacketParseError } from '../errors.js';
import { crc16X25 } from '../lib/crc.js';
import { minutes30000ToDegrees } from '../lib/geo.js';
import { bcdImei, binaryDate, lazyHexData } from '../lib/protocol.js';
import type { Alarm, GpsPosition, ParsedPacket } from '../types.js';

const PROTO = {
  LOGIN: 0x01,
  GPS: 0x10,
  LBS: 0x11,
  GPS_LBS: 0x12,
  STATUS: 0x13,
  ALARM: 0x16,
  ALARM_2: 0x18,
  LBS_PHONE: 0x19,
} as const;

/** Concox frame markers: `7878` (1-byte length) and extended `7979` (2-byte length). */
export const GT06_FRAME_MARKERS: readonly FrameMarker[] = [
  {
    marker: Buffer.from([0x78, 0x78]),
    lengthOffset: 2,
    lengthBytes: 1,
    totalLength: (len) => len + 5,
  },
  {
    marker: Buffer.from([0x79, 0x79]),
    lengthOffset: 2,
    lengthBytes: 2,
    totalLength: (len) => len + 6,
  },
];

// Alarm byte in the alarm/language field (Concox GT06 doc).
const ALARM_BYTE: Record<number, Alarm> = {
  0x01: { code: 'sos', message: 'SOS button pressed' },
  0x02: { code: 'power_cut', message: 'Power was cut off' },
  0x03: { code: 'vibration', message: 'Vibration/shock detected' },
  0x04: { code: 'geofence_enter', message: 'Vehicle entered the geofence' },
  0x05: { code: 'geofence_exit', message: 'Vehicle left the geofence' },
  0x06: { code: 'overspeed', message: 'Vehicle is over the configured maximum speed' },
};

// Alarm encoded in bits 5-3 of the terminal-info byte (GK309 protocol doc V1.8).
const TERMINAL_INFO_ALARM: Record<number, Alarm> = {
  0b010: { code: 'power_on', message: 'Terminal powered on' },
  0b011: { code: 'low_battery', message: 'Battery is low' },
  0b100: { code: 'sos', message: 'SOS button pressed' },
  0b101: { code: 'geofence_enter', message: 'Vehicle entered the geofence' },
  0b110: { code: 'geofence_exit', message: 'Vehicle left the geofence' },
  0b111: { code: 'power_off', message: 'Terminal powered off' },
};

/**
 * Concox GT06 binary protocol (also GK309, GK301, GK306 and many clones):
 * `7878 | len | proto | content | serial(2) | crc16-x25(2) | 0d0a`
 * (extended frames use `7979` with a 2-byte length).
 */
export class Gt06Adapter extends BaseAdapter {
  static override readonly protocol: string = 'GT06';
  static override readonly modelName: string = 'GT06';
  static override readonly compatibleHardware: readonly string[] = ['GT06/supplier', 'GK309', 'GK301', 'GK306'];

  createFramer(options: FramerOptions): Framer {
    return new LengthPrefixedFramer({ markers: GT06_FRAME_MARKERS, ...options });
  }

  parsePacket(frame: Buffer): ParsedPacket {
    if (frame.length < 10 || frame.readUInt16BE(frame.length - 2) !== 0x0d0a) {
      throw new PacketParseError('GT06: invalid frame tail');
    }
    const crc = frame.readUInt16BE(frame.length - 4);
    const computed = crc16X25(frame.subarray(2, frame.length - 4));
    if (crc !== computed) {
      throw new PacketParseError(
        `GT06: CRC mismatch (got 0x${crc.toString(16)}, computed 0x${computed.toString(16)})`,
      );
    }

    const proto = this.#proto(frame);
    const content = frame.subarray((frame.readUInt16BE(0) === 0x7979 ? 4 : 3) + 1, frame.length - 6);
    const serial = frame.readUInt16BE(frame.length - 6);
    const base = {
      cmd: proto.toString(16).padStart(2, '0'),
      raw: frame,
      serial,
    };

    let packet: ParsedPacket;
    switch (proto) {
      case PROTO.LOGIN: {
        if (content.length < 8) {
          throw new PacketParseError('GT06: login packet too short');
        }
        packet = { ...base, action: 'loginRequest', deviceId: bcdImei(content.subarray(0, 8)) };
        break;
      }
      case PROTO.GPS:
      case PROTO.GPS_LBS:
        packet = { ...base, action: 'ping', position: this.#parsePosition(content) };
        break;
      case PROTO.ALARM:
      case PROTO.ALARM_2:
        packet = { ...base, action: 'alarm', ...this.#parseAlarm(content) };
        break;
      case PROTO.STATUS:
        packet = { ...base, action: 'heartbeat' };
        break;
      default:
        packet = { ...base, action: 'other' };
    }
    return lazyHexData(packet, content);
  }

  authorize(packet: ParsedPacket): void {
    this.#sendAck(PROTO.LOGIN, packet.serial ?? 0);
  }

  override ackPing(packet: ParsedPacket): void {
    this.#echoAck(packet);
  }

  override ackAlarm(packet: ParsedPacket): void {
    this.#echoAck(packet);
  }

  override ackHeartbeat(packet: ParsedPacket): void {
    this.#echoAck(packet);
  }

  override handleCommand(packet: ParsedPacket): void {
    const proto = this.#proto(packet.raw);
    if (proto === PROTO.LBS || proto === PROTO.LBS_PHONE) {
      this.#sendAck(proto, packet.serial ?? 0);
    }
  }

  #proto(frame: Buffer): number {
    return frame.readUInt8(frame.readUInt16BE(0) === 0x7979 ? 4 : 3);
  }

  /** Ack a packet by echoing its protocol number and serial. */
  #echoAck(packet: ParsedPacket): void {
    this.#sendAck(this.#proto(packet.raw), packet.serial ?? 0);
  }

  /** Generic 10-byte server response: 7878 05 <proto> <serial> <crc> 0d0a */
  #sendAck(proto: number, serial: number): void {
    const response = Buffer.alloc(10);
    response.writeUInt16BE(0x7878, 0);
    response.writeUInt8(0x05, 2);
    response.writeUInt8(proto, 3);
    response.writeUInt16BE(serial, 4);
    response.writeUInt16BE(crc16X25(response.subarray(2, 6)), 6);
    response.writeUInt16BE(0x0d0a, 8);
    this.device.send(response);
  }

  // datetime(6) + gpsInfo(1) + lat(4) + lon(4) + speed(1) + courseStatus(2) [+ LBS ...]
  #parsePosition(content: Buffer): GpsPosition {
    if (content.length < 18) {
      throw new PacketParseError('GT06: position content too short');
    }
    const courseStatus = content.readUInt16BE(16);
    const north = (courseStatus & 0x0400) !== 0;
    const west = (courseStatus & 0x0800) !== 0;
    const latitude = minutes30000ToDegrees(content.readUInt32BE(7));
    const longitude = minutes30000ToDegrees(content.readUInt32BE(11));

    return {
      latitude: north ? latitude : -latitude,
      longitude: west ? -longitude : longitude,
      time: binaryDate(content),
      valid: (courseStatus & 0x1000) !== 0,
      speed: content.readUInt8(15),
      orientation: courseStatus & 0x03ff,
      satellites: content.readUInt8(6) & 0x0f,
    };
  }

  // gps(18) + lbsLength(1) + mcc(2) + mnc(1) + lac(2) + cellId(3) + terminalInfo + voltage + gsm + alarmLang(2)
  #parseAlarm(content: Buffer): { alarm: Alarm; position: GpsPosition } {
    const position = this.#parsePosition(content);
    if (content.length < 32) {
      return { alarm: { code: 'alarm', message: 'Device alarm' }, position };
    }
    const terminalInfo = content.readUInt8(27);
    const alarmByte = content.readUInt8(30);
    const alarm =
      ALARM_BYTE[alarmByte] ??
      TERMINAL_INFO_ALARM[(terminalInfo >> 3) & 0b111] ??
      ({ code: `alarm_${alarmByte}`, message: `Unknown GT06 alarm 0x${alarmByte.toString(16)}` } satisfies Alarm);
    position.extra = {
      terminalInfo,
      voltage: content.readUInt8(28),
      gsmSignal: content.readUInt8(29),
      mcc: content.readUInt16BE(19),
      mnc: content.readUInt8(21),
      lac: content.readUInt16BE(22),
      cellId: content.readUIntBE(24, 3),
    };
    return { alarm: { ...alarm, raw: alarmByte.toString(16).padStart(2, '0') }, position };
  }
}

/**
 * Concox GK309 (and GK301/GK306): same wire protocol as GT06.
 * Kept as a named adapter so `adapters.GK309` works and shows the right model name.
 */
export class Gk309Adapter extends Gt06Adapter {
  static override readonly modelName: string = 'GK309';
  static override readonly compatibleHardware: readonly string[] = ['GK309', 'GK301', 'GK306'];
}
