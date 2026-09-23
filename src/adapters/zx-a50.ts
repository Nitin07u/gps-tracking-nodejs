import type { Device } from '../device.js';
import { BaseAdapter } from './base-adapter.js';
import { LengthPrefixedFramer, type FrameMarker } from '../framing/length-prefixed-framer.js';
import type { Framer, FramerOptions } from '../framing/framer.js';
import { PacketParseError } from '../errors.js';
import { minutes30000ToDegrees } from '../lib/geo.js';
import { bcdImei, binaryDate, lazyHexData } from '../lib/protocol.js';
import type { GpsPosition, ParsedPacket } from '../types.js';

const PROTO = {
  LOGIN: 0x01,
  HEARTBEAT: 0x08,
  GPS: 0x10,
  GPS_OFFLINE: 0x11,
  STATUS: 0x13,
  WIFI_LBS_OFFLINE: 0x17,
  TIME_SYNC: 0x30,
  SETTINGS: 0x57,
  WIFI_LBS_ONLINE: 0x69,
  LOGIN_FAIL: 0x44,
} as const;

/** V1.2 alert byte appended after altitude on 0x10/0x11 (see the doc's changelog). */
const ALERT_FLAG: Record<number, string> = {
  0b0000_0001: 'vibration',
  0b0000_0010: 'speeding',
  0b0000_0100: 'wifi_attendance',
  0b0000_1000: 'leave_wifi_attendance',
  0b0001_0000: 'low_power',
};

/** `7878 | len(1) | proto+content | 0d0a`. No serial number or CRC (unlike Concox GT06). */
const A50_FRAME_MARKERS: readonly FrameMarker[] = [
  {
    marker: Buffer.from([0x78, 0x78]),
    lengthOffset: 2,
    lengthBytes: 1,
    totalLength: (len) => len + 5,
  },
];

/** A single weekly alarm-clock entry for {@link A50Settings.alarmClocks} (0x50/0x57). */
export interface A50AlarmClock {
  /** 1-7 per the doc's own worked example (010800 = "every Monday, 8:00"). */
  weekday: number;
  hour: number;
  minute: number;
}

/** "HH:MM" pair encoded as 2 packed-BCD bytes each, e.g. a do-not-disturb or GPS-off window. */
export interface A50TimeWindow {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

/**
 * Settings pushed to the device in reply to its 0x57 request. All switches
 * and windows default to "off"/zero, matching the doc's own convention for
 * "no alarm set" (`7878 0a 50 000000 000000 000000 0d0a`).
 */
export interface A50Settings {
  /** Position/status upload interval, in seconds (encoded as 2-byte BCD, e.g. 60 -> 0x0060). */
  uploadIntervalSeconds?: number;
  switches?: {
    gps?: boolean;
    step?: boolean;
    vibrationAlarm?: boolean;
    bluetooth?: boolean;
    lightSense?: boolean;
    sensorSwitch?: boolean;
  };
  /** Up to 3 weekly alarms; omitted entries are sent as all-zero (disabled). */
  alarmClocks?: readonly A50AlarmClock[];
  doNotDisturb?: {
    enabled: boolean;
    /** Bitmask/ordinal for the active weekday(s), per the 0x47 format this field mirrors. */
    weekday: number;
    window1: A50TimeWindow;
    window2: A50TimeWindow;
  };
  gpsTimer?: {
    enabled: boolean;
    window: A50TimeWindow;
  };
  /** ASCII phone numbers for the SOS/mom/dad quick-dial slots (0x41/0x42/0x43). */
  sos?: string;
  mom?: string;
  dad?: string;
}

function bcdByte(value: number): number {
  return ((Math.floor(value / 10) % 10) << 4) | (value % 10);
}

function bcdWord(value: number): number {
  return (bcdByte(Math.floor(value / 100)) << 8) | bcdByte(value % 100);
}

function encodeWindow(window: A50TimeWindow | undefined): Buffer {
  if (!window) return Buffer.from([0, 0, 0, 0]);
  return Buffer.from([
    bcdByte(window.startHour),
    bcdByte(window.startMinute),
    bcdByte(window.endHour),
    bcdByte(window.endMinute),
  ]);
}

/**
 * Zhongxun "A50" locator protocol (per the vendor's "Zhongxun Locator
 * Communication Protocol" document, V1.3). It shares Concox GT06's `7878`
 * start marker and 18-byte GPS payload layout, but differs in two important
 * ways: frames carry no serial number or CRC, and most acks echo the
 * protocol number plus the fix's own date/time instead of a serial+CRC pair.
 *
 * Implements the document's "minimum support" set (its section, item 9):
 * 0x01 login, 0x08 heartbeat, 0x10/0x11 GPS (on/offline), 0x13 status,
 * 0x17/0x69 offline/online WIFI+LBS, 0x30 time sync, 0x57 settings sync —
 * i.e. every protocol number the doc says a device requires a reply to
 * (0x01, 0x10, 0x11, 0x13, 0x17, 0x69) in order to avoid a reconnect loop.
 *
 * Caveat: the source document's own worked examples are internally
 * inconsistent about the length byte — e.g. its 0x10/0x11 GPS examples show
 * a length one less than `1 (protocol) + payload.length`, while its 0x01
 * login example matches that formula exactly. This adapter trusts the
 * formula the document states in its introduction (section 3) for framing;
 * validate against real device captures before relying on this against
 * hardware, and adjust `A50_FRAME_MARKERS.totalLength` if real devices prove
 * to follow the examples instead of the stated rule.
 */
export class ZxA50Adapter extends BaseAdapter {
  static override readonly protocol: string = 'ZX-A50';
  static override readonly modelName: string = 'A50';
  static override readonly compatibleHardware: readonly string[] = ['Zhongxun A50', 'A50 GPS locator'];

  readonly #now: () => Date;

  constructor(device: Device, options: { now?: () => Date } = {}) {
    super(device);
    this.#now = options.now ?? (() => new Date());
  }

  createFramer(options: FramerOptions): Framer {
    return new LengthPrefixedFramer({ markers: A50_FRAME_MARKERS, ...options });
  }

  parsePacket(frame: Buffer): ParsedPacket {
    if (frame.length < 6 || frame.readUInt16BE(frame.length - 2) !== 0x0d0a) {
      throw new PacketParseError('A50: invalid frame tail');
    }
    const proto = this.#proto(frame);
    const payload = frame.subarray(4, frame.length - 2);
    const base = { cmd: proto.toString(16).padStart(2, '0'), raw: frame };

    let packet: ParsedPacket;
    switch (proto) {
      case PROTO.LOGIN: {
        if (payload.length < 8) {
          throw new PacketParseError('A50: login packet too short');
        }
        packet = { ...base, action: 'loginRequest', deviceId: bcdImei(payload.subarray(0, 8)) };
        break;
      }
      case PROTO.HEARTBEAT:
        // Not in the doc's mandatory-reply list (item 8): pure keep-alive, no ack needed.
        packet = { ...base, action: 'heartbeat' };
        break;
      case PROTO.GPS:
      case PROTO.GPS_OFFLINE:
        packet = { ...base, action: 'ping', position: this.#parsePosition(payload) };
        break;
      default:
        packet = { ...base, action: 'other' };
    }
    return lazyHexData(packet, payload);
  }

  authorize(_packet: ParsedPacket): void {
    this.#send(PROTO.LOGIN, Buffer.alloc(0));
  }

  /**
   * Reject a pending login with the doc's own "login failed" reply (0x44).
   * Call this instead of `device.acceptLogin()`; it does not disconnect by
   * itself (call `device.disconnect()` too if that's desired).
   */
  rejectLoginFrame(): void {
    this.#send(PROTO.LOGIN_FAIL, Buffer.alloc(0));
  }

  override ackPing(packet: ParsedPacket): void {
    // 0x10/0x11 ack = protocol number + the fix's own date/time (6 bytes), not a serial+CRC.
    const proto = this.#proto(packet.raw);
    const date = packet.raw.subarray(4, 10);
    this.#send(proto, date);
  }

  override handleCommand(packet: ParsedPacket): void {
    const proto = this.#proto(packet.raw);
    const payload = packet.raw.subarray(4, packet.raw.length - 2);
    switch (proto) {
      case PROTO.STATUS:
        // "Reply content is the same as sending status package" (doc, 0x13).
        this.#send(PROTO.STATUS, payload);
        break;
      case PROTO.WIFI_LBS_OFFLINE:
      case PROTO.WIFI_LBS_ONLINE:
        // Must ack with protocol number + date/time (first 6 payload bytes) or the device disconnects.
        this.#send(proto, payload.subarray(0, Math.min(6, payload.length)));
        break;
      case PROTO.TIME_SYNC:
        // Doc example decodes as a 7-byte date (2-byte full year + month/day/h/m/s single
        // bytes: `07E0 07 05 05 37 18` = year 0x07E0=2016, 5:55:24 on July 5) — NOT the
        // 6-byte one-byte-year format 0x10/0x11 use. Kept local since it's specific to 0x30.
        this.#send(PROTO.TIME_SYNC, this.#encodeFullDate(this.#now()));
        break;
      case PROTO.SETTINGS:
        // The device is requesting its settings (0x57). The reply is
        // application data (alarms, phone numbers, switches) that this
        // library can't invent — call `sendSettings()` with the values to push.
        break;
      default:
        break;
    }
  }

  /** Push settings to the device in reply to a 0x57 request (or unprompted). */
  sendSettings(settings: A50Settings = {}): void {
    const switches = settings.switches ?? {};
    const switchByte =
      (switches.gps ? 0b0000_0001 : 0) |
      (switches.step ? 0b0000_0010 : 0) |
      (switches.vibrationAlarm ? 0b0000_0100 : 0) |
      (switches.bluetooth ? 0b0000_1000 : 0) |
      (switches.lightSense ? 0b0001_0000 : 0) |
      (switches.sensorSwitch ? 0b0010_0000 : 0);

    const alarms = settings.alarmClocks ?? [];
    const alarmBytes = Buffer.alloc(9);
    for (let i = 0; i < 3; i++) {
      const alarm = alarms[i];
      if (alarm) {
        alarmBytes.writeUInt8(alarm.weekday, i * 3);
        alarmBytes.writeUInt8(bcdByte(alarm.hour), i * 3 + 1);
        alarmBytes.writeUInt8(bcdByte(alarm.minute), i * 3 + 2);
      }
    }

    const dnd = settings.doNotDisturb;
    const dndTime = Buffer.concat([
      Buffer.from([dnd?.weekday ?? 0]),
      encodeWindow(dnd?.window1),
      encodeWindow(dnd?.window2),
    ]);

    const gpsTimer = settings.gpsTimer;

    const payload = Buffer.concat([
      Buffer.from([bcdWord(settings.uploadIntervalSeconds ?? 60) >> 8, bcdWord(settings.uploadIntervalSeconds ?? 60) & 0xff]),
      Buffer.from([switchByte]),
      alarmBytes,
      Buffer.from([dnd?.enabled ? 1 : 0]),
      dndTime,
      Buffer.from([gpsTimer?.enabled ? 1 : 0]),
      encodeWindow(gpsTimer?.window),
      Buffer.from(`${settings.sos ?? ''};${settings.mom ?? ''};${settings.dad ?? ''}`, 'ascii'),
    ]);

    this.#send(PROTO.SETTINGS, payload);
  }

  #proto(frame: Buffer): number {
    return frame.readUInt8(3);
  }

  /** 2-byte full year (BE) + month + day + hour + minute + second, per the 0x30 reply example. */
  #encodeFullDate(date: Date): Buffer {
    const buf = Buffer.alloc(7);
    buf.writeUInt16BE(date.getUTCFullYear(), 0);
    buf.writeUInt8(date.getUTCMonth() + 1, 2);
    buf.writeUInt8(date.getUTCDate(), 3);
    buf.writeUInt8(date.getUTCHours(), 4);
    buf.writeUInt8(date.getUTCMinutes(), 5);
    buf.writeUInt8(date.getUTCSeconds(), 6);
    return buf;
  }

  /** `7878 | len(1)=proto+payload | proto | payload | 0d0a`. */
  #send(proto: number, payload: Buffer): void {
    const frame = Buffer.alloc(6 + payload.length);
    frame.writeUInt16BE(0x7878, 0);
    frame.writeUInt8(payload.length + 1, 2);
    frame.writeUInt8(proto, 3);
    payload.copy(frame, 4);
    frame.writeUInt16BE(0x0d0a, frame.length - 2);
    this.device.send(frame);
  }

  // date(6) + gpsInfo(1) + lat(4) + lon(4) + speed(1) + courseStatus(2) [+ altitude(2) + alert(1), V1.2+]
  #parsePosition(payload: Buffer): GpsPosition {
    if (payload.length < 18) {
      throw new PacketParseError('A50: position payload too short');
    }
    const courseStatus = payload.readUInt16BE(16);
    const north = (courseStatus & 0x0400) !== 0;
    const west = (courseStatus & 0x0800) !== 0;
    const latitude = minutes30000ToDegrees(payload.readUInt32BE(7));
    const longitude = minutes30000ToDegrees(payload.readUInt32BE(11));

    const position: GpsPosition = {
      latitude: north ? latitude : -latitude,
      longitude: west ? -longitude : longitude,
      time: binaryDate(payload),
      valid: (courseStatus & 0x1000) !== 0,
      speed: payload.readUInt8(15),
      orientation: courseStatus & 0x03ff,
      satellites: payload.readUInt8(6) & 0x0f,
    };

    if (payload.length >= 21) {
      const altitude = payload.readUInt16BE(18);
      const alertByte = payload.readUInt8(20);
      const alerts = Object.entries(ALERT_FLAG)
        .filter(([bit]) => (alertByte & Number(bit)) !== 0)
        .map(([, name]) => name);
      position.extra = { altitude, alerts };
    }

    return position;
  }
}
