import type { Socket } from 'node:net';
import { TypedEmitter } from './typed-emitter.js';
import { PacketParseError } from './errors.js';
import { DEFAULT_MAX_FRAME_LENGTH, type Framer } from './framing/framer.js';
import type { BaseAdapter, AdapterClass } from './adapters/base-adapter.js';
import type { DeviceEvents, Logger, ParsedPacket } from './types.js';

export interface DeviceOptions {
  logger?: Logger | false;
  maxFrameLength?: number;
  /** Destroy the connection after this much idle time. 0 disables. */
  connectionTimeoutMs?: number;
}

/**
 * One connected GPS tracker. Created by GpsServer for every TCP connection.
 * The Device owns its socket lifecycle: it subscribes to data/error/timeout/close
 * and emits its own events; GpsServer only does registry bookkeeping on top.
 */
export class Device extends TypedEmitter<DeviceEvents> {
  /** The raw TCP socket, for advanced use. */
  readonly socket: Socket;
  readonly adapter: BaseAdapter;
  /** Free-form label you can assign to this device. */
  name: string | undefined;

  readonly #framer: Framer;
  readonly #logger: Logger | false;
  readonly #requiresLogin: boolean;
  #id: string | undefined;
  #authenticated = false;
  #pendingLogin: ParsedPacket | undefined;

  constructor(socket: Socket, adapterClass: AdapterClass, options: DeviceOptions = {}) {
    super();
    this.socket = socket;
    this.#logger = options.logger ?? false;
    this.#requiresLogin = adapterClass.requiresLogin ?? true;
    this.adapter = new adapterClass(this);
    this.#framer = this.adapter.createFramer({
      maxFrameLength: options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH,
    });

    if (options.connectionTimeoutMs && options.connectionTimeoutMs > 0) {
      socket.setTimeout(options.connectionTimeoutMs);
    }
    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('error', (error: Error) => {
      // A dropped connection (ECONNRESET & friends) must never crash the process.
      // Emitting 'error' with no listeners would throw, so only emit when someone listens.
      this.#log('warn', () => `socket error: ${error.message}`);
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
      socket.destroy();
    });
    socket.on('timeout', () => {
      this.#log('debug', () => 'connection timed out');
      this.emit('timeout');
      socket.destroy();
    });
    socket.on('close', () => {
      this.emit('disconnect');
    });
  }

  /** Device id (IMEI or protocol id). Undefined until the first packet that carries it. */
  get id(): string | undefined {
    return this.#id;
  }

  get remoteAddress(): string | undefined {
    return this.socket.remoteAddress;
  }

  get remotePort(): number | undefined {
    return this.socket.remotePort;
  }

  get isAuthenticated(): boolean {
    return this.#authenticated;
  }

  /** Feed raw data as if it came from the socket (useful for custom transports/tests). */
  handleData(chunk: Buffer): void {
    for (const frame of this.#framer.push(chunk)) {
      this.#handleFrame(frame);
    }
  }

  #handleFrame(frame: Buffer): void {
    let packet: ParsedPacket;
    try {
      packet = this.adapter.parsePacket(frame);
    } catch (error) {
      const parseError =
        error instanceof PacketParseError
          ? error
          : new PacketParseError(error instanceof Error ? error.message : String(error), {
              cause: error,
            });
      this.#log('warn', () => `discarding unparseable frame: ${parseError.message}`);
      this.emit('parseError', parseError, frame);
      return;
    }

    if (packet.action === 'ignore') {
      return;
    }

    if (packet.deviceId && !this.#id) {
      this.#id = packet.deviceId;
      this.emit('identified', packet.deviceId);
    }

    if (packet.action === 'loginRequest') {
      this.#pendingLogin = packet;
      this.#log('debug', () => 'login requested');
      this.emit('loginRequest', packet.deviceId, packet);
      return;
    }

    if (!this.#authenticated) {
      if (this.#requiresLogin) {
        this.adapter.requestLogin();
        this.#log('debug', () => `'${packet.action}' received before login; discarded`);
        return;
      }
      this.#authenticated = true;
      this.emit('login');
    }

    switch (packet.action) {
      case 'ping':
        this.#log('debug', () => `position (${packet.position.latitude}, ${packet.position.longitude})`);
        this.adapter.ackPing(packet);
        this.emit('ping', packet.position, packet);
        break;
      case 'alarm':
        this.adapter.ackAlarm(packet);
        this.emit('alarm', packet.alarm, packet);
        break;
      case 'heartbeat':
        this.adapter.ackHeartbeat(packet);
        this.emit('packet', packet);
        break;
      case 'other':
        this.adapter.handleCommand(packet);
        this.emit('packet', packet);
        break;
    }
  }

  /** Accept a pending login request: authenticates the device and sends the protocol ack. */
  acceptLogin(): void {
    const packet = this.#pendingLogin;
    if (!packet) {
      this.#log('warn', () => 'acceptLogin() called without a pending login request');
      return;
    }
    this.#authenticated = true;
    this.#pendingLogin = undefined;
    this.adapter.authorize(packet);
    this.#log('debug', () => 'login accepted');
    this.emit('login');
  }

  /** Reject a pending login request; optionally drop the connection. */
  rejectLogin(options: { disconnect?: boolean } = {}): void {
    this.#pendingLogin = undefined;
    this.#authenticated = false;
    this.#log('debug', () => 'login rejected');
    if (options.disconnect) {
      this.disconnect();
    }
  }

  /** Write raw data to the device. */
  send(data: Buffer | string): boolean {
    this.#log('debug', () => `sending: ${typeof data === 'string' ? data : data.toString('hex')}`);
    return this.socket.write(data);
  }

  /** Configure the device reporting interval, when the protocol supports it. */
  setRefreshInterval(intervalSeconds: number, durationSeconds: number): void {
    this.adapter.setRefreshInterval(intervalSeconds, durationSeconds);
  }

  /** Destroy the TCP connection. */
  disconnect(): void {
    this.socket.destroy();
  }

  // The message is a thunk so disabled logging (the default) costs nothing per packet.
  #log(level: 'debug' | 'warn', message: () => string): void {
    if (this.#logger) {
      this.#logger[level](`[gps-tracking] #${this.#id ?? this.remoteAddress ?? '?'}: ${message()}`);
    }
  }
}
