import type { AddressInfo } from 'node:net';
import type { Device } from './device.js';
import type { PacketParseError } from './errors.js';
import type { AdapterClass } from './adapters/base-adapter.js';

export interface GpsPosition {
  latitude: number;
  longitude: number;
  /** UTC fix time as reported by the device. */
  time: Date;
  /** GPS fix validity when the protocol reports it. */
  valid?: boolean;
  /** Speed in km/h. */
  speed?: number;
  /** Course over ground in degrees (0-360, north = 0). */
  orientation?: number;
  /** Odometer/mileage when the protocol reports it. */
  mileage?: number;
  satellites?: number;
  /** Protocol-specific fields (LBS info, IO state, ignition, battery...). */
  extra?: Record<string, unknown>;
}

export interface Alarm {
  /** Normalized code: 'sos', 'power_off', 'low_battery', 'overspeed', 'geofence_enter'... */
  code: string;
  message: string;
  /** Raw protocol alarm code, useful for acks and debugging. */
  raw?: string;
}

export interface PacketBase {
  /** Protocol command, e.g. 'BR00' (TK103) or '16' (GT06 protocol number in hex). */
  cmd: string;
  deviceId?: string;
  /** The complete frame as received. */
  raw: Buffer;
  /** Command payload (text protocols: string after the command; binary: hex string). */
  data?: string;
  /** Frame serial number, for protocols that ack by serial (GT06 family). */
  serial?: number;
}

export type ParsedPacket =
  | (PacketBase & { action: 'loginRequest'; deviceId: string })
  | (PacketBase & { action: 'ping'; position: GpsPosition })
  | (PacketBase & { action: 'alarm'; alarm: Alarm; position?: GpsPosition })
  | (PacketBase & { action: 'heartbeat' })
  | (PacketBase & { action: 'other' })
  | (PacketBase & { action: 'ignore' });

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ServerOptions {
  /** Adapter class for the protocol this server listens for, e.g. `adapters.TK103`. */
  adapter: AdapterClass;
  /** TCP port to listen on. Default 8090. Use 0 for a random free port. */
  port?: number;
  host?: string;
  /** Idle sockets are destroyed after this. Default 120000 ms. Set 0 to disable. */
  connectionTimeoutMs?: number;
  /** Maximum accepted frame size in bytes. Default 4096. */
  maxFrameLength?: number;
  /** Pass `console` (or any Logger) to enable logging. Default: silent. */
  logger?: Logger | false;
}

export type ServerEvents = {
  listening: [address: AddressInfo];
  connection: [device: Device];
  disconnect: [device: Device];
  error: [error: Error];
  close: [];
};

export type DeviceEvents = {
  /** The device asked to log in. Call `device.acceptLogin()` or `device.rejectLogin()`. */
  loginRequest: [deviceId: string, packet: ParsedPacket];
  /** The device is authenticated (after acceptLogin, or automatically for login-less protocols). */
  login: [];
  /** The device id became known (first packet that carries it). */
  identified: [deviceId: string];
  ping: [position: GpsPosition, packet: ParsedPacket];
  alarm: [alarm: Alarm, packet: ParsedPacket];
  /** Any other packet (heartbeats, protocol-specific commands). */
  packet: [packet: ParsedPacket];
  parseError: [error: PacketParseError, frame: Buffer];
  error: [error: Error];
  timeout: [];
  disconnect: [];
};
