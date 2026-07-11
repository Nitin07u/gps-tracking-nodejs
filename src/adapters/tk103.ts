import { BaseAdapter } from './base-adapter.js';
import { DelimiterFramer } from '../framing/delimiter-framer.js';
import type { Framer, FramerOptions } from '../framing/framer.js';
import { PacketParseError } from '../errors.js';
import { minuteToDecimal } from '../lib/geo.js';
import { digits2, lookupAlarm, utcDate } from '../lib/protocol.js';
import type { Alarm, GpsPosition, ParsedPacket } from '../types.js';

const ALARMS: Record<string, Alarm> = {
  '0': { code: 'power_off', message: 'Vehicle power off', raw: '0' },
  '1': { code: 'accident', message: 'The vehicle suffered an accident', raw: '1' },
  '2': { code: 'sos', message: 'Driver sent an S.O.S.', raw: '2' },
  '3': { code: 'alarming', message: 'The vehicle alarm was activated', raw: '3' },
  '4': { code: 'low_speed', message: 'Vehicle is below the configured minimum speed', raw: '4' },
  '5': { code: 'overspeed', message: 'Vehicle is over the configured maximum speed', raw: '5' },
  '6': { code: 'geofence_exit', message: 'Vehicle left the geofence', raw: '6' },
};

/**
 * TK103 / GPS103 text protocol: `(<deviceId><cmd><data>)`.
 * Commands: BP05 login, BR00 position, BO01 alarm, BP00 handshake.
 */
export class Tk103Adapter extends BaseAdapter {
  static override readonly protocol = 'GPS103';
  static override readonly modelName = 'TK103';
  static override readonly compatibleHardware = ['TK103/supplier'] as const;

  createFramer(options: FramerOptions): Framer {
    return new DelimiterFramer({ start: 0x28, end: 0x29, ...options }); // ( )
  }

  parsePacket(frame: Buffer): ParsedPacket {
    const body = frame.toString('ascii').slice(1, -1);
    const cmdStart = body.indexOf('B');
    if (cmdStart < 0 || cmdStart > 12) {
      throw new PacketParseError(`TK103: no command found or device id longer than 12 chars: ${body}`);
    }
    const deviceId = body.slice(0, cmdStart);
    const cmd = body.slice(cmdStart, cmdStart + 4);
    const data = body.slice(cmdStart + 4);
    const base = { cmd, deviceId, data, raw: frame };

    switch (cmd) {
      case 'BP05':
        return { ...base, action: 'loginRequest', deviceId };
      case 'BR00':
        return { ...base, action: 'ping', position: this.#parsePosition(data) };
      case 'BO01': {
        const alarm = lookupAlarm(ALARMS, data.slice(0, 1), 'TK103');
        // Alarm packets carry the same position payload after the alarm code.
        let position: GpsPosition | undefined;
        try {
          position = this.#parsePosition(data.slice(1));
        } catch {
          position = undefined;
        }
        return { ...base, action: 'alarm', alarm, position };
      }
      default:
        return { ...base, action: 'other' };
    }
  }

  authorize(packet: ParsedPacket): void {
    this.device.send(`(${packet.deviceId ?? this.device.id}AP05)`);
  }

  override ackAlarm(packet: ParsedPacket): void {
    if (packet.action === 'alarm' && packet.alarm.raw !== undefined) {
      this.device.send(`(${this.device.id}AS01${packet.alarm.raw})`);
    }
  }

  override handleCommand(packet: ParsedPacket): void {
    if (packet.cmd === 'BP00') {
      // Handshake
      this.device.send(`(${this.device.id}AP01HSO)`);
    }
  }

  override setRefreshInterval(intervalSeconds: number, durationSeconds: number): void {
    // AR00 + XXXX (interval, hex seconds) + YY (hex hours) + ZZ (hex minutes)
    const hours = Math.floor(durationSeconds / 3600);
    const minutes = Math.floor((durationSeconds - hours * 3600) / 60);
    const time =
      intervalSeconds.toString(16).padStart(4, '0') +
      hours.toString(16).padStart(2, '0') +
      minutes.toString(16).padStart(2, '0');
    this.device.send(`(${this.device.id}AR00${time})`);
  }

  // YYMMDD + A/V + DDMM.MMMM + N/S + DDDMM.MMMM + E/W + speed(5) + HHMMSS + course(6) + io(8) + L + mileage(hex 8)
  #parsePosition(data: string): GpsPosition {
    if (data.length < 45) {
      throw new PacketParseError(`TK103: position payload too short: ${data}`);
    }
    const latitude = minuteToDecimal(Number.parseFloat(data.slice(7, 16)), data[16] ?? 'N');
    const longitude = minuteToDecimal(Number.parseFloat(data.slice(17, 27)), data[27] ?? 'E');
    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
      throw new PacketParseError(`TK103: invalid coordinates in payload: ${data}`);
    }
    const position: GpsPosition = {
      latitude,
      longitude,
      time: utcDate(
        digits2(data, 0),
        digits2(data, 2),
        digits2(data, 4),
        digits2(data, 33),
        digits2(data, 35),
        digits2(data, 37),
      ),
      valid: data[6] === 'A',
      speed: Number.parseFloat(data.slice(28, 33)),
      orientation: Number.parseFloat(data.slice(39, 45)),
      extra: { ioState: data.slice(45, 53) },
    };
    if (data[53] === 'L') {
      position.mileage = Number.parseInt(data.slice(54, 62), 16);
    }
    return position;
  }

}
