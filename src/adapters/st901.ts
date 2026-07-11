import { BaseAdapter } from './base-adapter.js';
import { DelimiterFramer } from '../framing/delimiter-framer.js';
import type { Framer, FramerOptions } from '../framing/framer.js';
import { PacketParseError } from '../errors.js';
import { lookupAlarm, parseRmcPosition } from '../lib/protocol.js';
import type { Alarm, GpsPosition, ParsedPacket } from '../types.js';

const ALARMS: Record<string, Alarm> = {
  '1': { code: 'sos', message: 'SOS button pressed', raw: '1' },
  '2': { code: 'low_battery', message: 'Battery is low', raw: '2' },
  '3': { code: 'geofence', message: 'Geofence alarm', raw: '3' },
};

/**
 * H02 text protocol, used by the SinoTrack ST-901 and many other devices:
 * `*HQ,<id>,<cmd>,...#`
 *
 * There is no login handshake: the device id travels in every message
 * (ST-901 sends the last 10 IMEI digits; other firmwares the full IMEI),
 * so devices authenticate automatically on their first valid packet.
 *
 * Note: some ST-901 firmwares additionally emit a fixed-length binary packet
 * starting with `$`. That variant is not supported by this adapter.
 */
export class St901Adapter extends BaseAdapter {
  static override readonly protocol = 'H02';
  static override readonly modelName = 'ST-901';
  static override readonly compatibleHardware = ['SinoTrack ST-901', 'H02 family'] as const;
  static override readonly requiresLogin = false;

  createFramer(options: FramerOptions): Framer {
    return new DelimiterFramer({ start: 0x2a, end: 0x23, ...options }); // * #
  }

  parsePacket(frame: Buffer): ParsedPacket {
    const body = frame.toString('ascii').slice(1, -1);
    const fields = body.split(',');
    if (fields.length < 3) {
      throw new PacketParseError(`H02: malformed frame: ${frame.toString('ascii')}`);
    }
    const deviceId = (fields[1] ?? '').trim();
    const cmd = (fields[2] ?? '').trim();
    // The payload is the original body after the third comma (no re-join needed).
    const data =
      fields.length > 3
        ? body.slice((fields[0]?.length ?? 0) + (fields[1]?.length ?? 0) + (fields[2]?.length ?? 0) + 3)
        : '';
    const base = { cmd, deviceId, data, raw: frame };

    switch (cmd) {
      case 'V1':
        return { ...base, action: 'ping', position: this.#parsePosition(fields) };
      case 'HTBT':
      case 'XT':
      case 'V0':
        return { ...base, action: 'heartbeat' };
      case 'ALRM': {
        const raw = (fields[3] ?? '').trim();
        return { ...base, action: 'alarm', alarm: lookupAlarm(ALARMS, raw, 'H02') };
      }
      case 'V4':
        // Echo/ack of a server command; nothing to do.
        return { ...base, action: 'ignore' };
      default:
        return { ...base, action: 'other' };
    }
  }

  authorize(): void {
    // H02 has no login handshake (requiresLogin = false); nothing to send.
  }

  override ackHeartbeat(packet: ParsedPacket): void {
    if (packet.cmd === 'HTBT') {
      // Newer ST-901 firmwares require the heartbeat to be echoed back.
      this.device.send(`*HQ,${packet.deviceId},HTBT#`);
    }
  }

  // V1 fields (after maker,id,cmd): RMC core + status(hex32) [, mcc, mnc, lac, cid ...]
  #parsePosition(fields: string[]): GpsPosition {
    const position = parseRmcPosition(fields, 3, 'H02');

    const extra: Record<string, unknown> = {};
    const status = (fields[12] ?? '').trim();
    if (status.length === 8) {
      const statusValue = Number.parseInt(status, 16);
      if (!Number.isNaN(statusValue)) {
        extra.status = status;
        extra.ignition = ((statusValue >>> 10) & 1) === 1;
      }
    }
    if (fields.length > 13) {
      extra.lbs = fields.slice(13).map((field) => field.trim());
    }
    position.extra = extra;
    return position;
  }
}
