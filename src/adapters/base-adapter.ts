import type { Device } from '../device.js';
import type { Framer, FramerOptions } from '../framing/framer.js';
import type { ParsedPacket } from '../types.js';
import { NotSupportedError } from '../errors.js';

/**
 * Contract for a protocol adapter. One instance is created per connection,
 * so instances may hold per-connection state (serial counters, cached ids...).
 */
export abstract class BaseAdapter {
  /** Protocol name, e.g. 'GPS103'. */
  static readonly protocol: string = '';
  /** Device model this adapter targets, e.g. 'TK103'. */
  static readonly modelName: string = '';
  static readonly compatibleHardware: readonly string[] = [];
  /**
   * Whether the protocol has a login handshake. When false (e.g. H02/ST-901),
   * the device is authenticated automatically on its first valid packet.
   */
  static readonly requiresLogin: boolean = true;

  constructor(protected readonly device: Device) {}

  /**
   * Create the framer that splits the TCP stream into frames for this protocol.
   * Infrastructure limits (maxFrameLength) are injected via `options`.
   */
  abstract createFramer(options: FramerOptions): Framer;

  /**
   * Parse one complete frame into a ParsedPacket.
   * Throw PacketParseError for corrupt frames (bad CRC, malformed fields);
   * the server emits it as a `parseError` event and keeps running.
   */
  abstract parsePacket(frame: Buffer): ParsedPacket;

  /** Send the protocol's login acknowledgement. Called by `device.acceptLogin()`. */
  abstract authorize(packet: ParsedPacket): void;

  /** Ask the device to log in (sent when an unauthenticated device sends data). */
  requestLogin(): void {}

  /** Acknowledge a position packet, for protocols that require it. */
  ackPing(_packet: ParsedPacket): void {}

  /** Acknowledge an alarm packet. */
  ackAlarm(_packet: ParsedPacket): void {}

  /** Acknowledge a heartbeat packet. */
  ackHeartbeat(_packet: ParsedPacket): void {}

  /** Handle protocol-specific commands (action 'other'), e.g. handshakes. */
  handleCommand(_packet: ParsedPacket): void {}

  /** Configure the device reporting interval, when the protocol supports it. */
  setRefreshInterval(_intervalSeconds: number, _durationSeconds: number): void {
    throw new NotSupportedError(
      `${(this.constructor as typeof BaseAdapter).modelName || this.constructor.name} does not support setRefreshInterval`,
    );
  }
}

/** Constructor + static metadata shape expected by ServerOptions.adapter. */
export interface AdapterClass {
  new (device: Device): BaseAdapter;
  readonly protocol: string;
  readonly modelName: string;
  readonly compatibleHardware?: readonly string[];
  readonly requiresLogin?: boolean;
}
