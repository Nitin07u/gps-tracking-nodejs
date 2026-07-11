import net, { type AddressInfo, type Socket } from 'node:net';
import { TypedEmitter } from './typed-emitter.js';
import { Device } from './device.js';
import { AdapterError } from './errors.js';
import { DEFAULT_MAX_FRAME_LENGTH } from './framing/framer.js';
import type { AdapterClass } from './adapters/base-adapter.js';
import type { Logger, ServerEvents, ServerOptions } from './types.js';

const DEFAULT_PORT = 8090;
const DEFAULT_CONNECTION_TIMEOUT_MS = 120_000;

/**
 * TCP server that listens for one GPS tracker protocol.
 * Create it with {@link createServer}, subscribe to `connection`, then `listen()`.
 */
export class GpsServer extends TypedEmitter<ServerEvents> {
  readonly #net: net.Server;
  readonly #adapter: AdapterClass;
  readonly #port: number;
  readonly #host: string | undefined;
  readonly #connectionTimeoutMs: number;
  readonly #maxFrameLength: number;
  readonly #logger: Logger | false;
  readonly #devices = new Map<string, Device>();
  readonly #connections = new Set<Device>();

  constructor(options: ServerOptions) {
    super();
    if (typeof options.adapter !== 'function') {
      throw new AdapterError(
        'ServerOptions.adapter must be an adapter class, e.g. adapters.TK103 (see MIGRATION.md if you are coming from v1)',
      );
    }
    this.#adapter = options.adapter;
    this.#port = options.port ?? DEFAULT_PORT;
    this.#host = options.host;
    this.#connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.#maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
    this.#logger = options.logger ?? false;
    this.#net = net.createServer((socket) => this.#handleConnection(socket));
    this.#net.on('error', (error) => {
      this.#log('warn', `server error: ${error.message}`);
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
    });
  }

  /** Devices that have identified themselves, keyed by device id. */
  get devices(): ReadonlyMap<string, Device> {
    return this.#devices;
  }

  /** The adapter class this server was created with. */
  get adapter(): AdapterClass {
    return this.#adapter;
  }

  getDevice(deviceId: string): Device | undefined {
    return this.#devices.get(deviceId);
  }

  /** Send raw data to a connected device by id. Returns false if it is not connected. */
  sendTo(deviceId: string, data: Buffer | string): boolean {
    const device = this.#devices.get(deviceId);
    if (!device) {
      return false;
    }
    return device.send(data);
  }

  /** Start listening. Resolves with the bound address (use port 0 for a random port). */
  listen(): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.#net.once('error', onError);
      this.#net.listen(this.#port, this.#host, () => {
        this.#net.off('error', onError);
        const address = this.#net.address() as AddressInfo;
        this.#log('info', `listening on port ${address.port} for ${this.#adapter.modelName || this.#adapter.name} devices`);
        this.emit('listening', address);
        resolve(address);
      });
    });
  }

  /** Stop listening and destroy every open connection. */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const device of this.#connections) {
        device.disconnect();
      }
      this.#net.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        this.emit('close');
        resolve();
      });
    });
  }

  #handleConnection(socket: Socket): void {
    const device = new Device(socket, this.#adapter, {
      logger: this.#logger,
      maxFrameLength: this.#maxFrameLength,
      connectionTimeoutMs: this.#connectionTimeoutMs,
    });
    this.#connections.add(device);
    this.#log('debug', `connection from ${socket.remoteAddress ?? '?'}`);

    // Register only after authentication: an unauthenticated peer claiming an
    // existing id must not become routable via getDevice()/sendTo().
    device.on('login', () => {
      if (device.id) {
        this.#devices.set(device.id, device);
      }
    });
    device.on('disconnect', () => {
      this.#connections.delete(device);
      if (device.id && this.#devices.get(device.id) === device) {
        this.#devices.delete(device.id);
      }
      this.emit('disconnect', device);
    });

    this.emit('connection', device);
  }

  #log(level: 'debug' | 'info' | 'warn', message: string): void {
    if (this.#logger) {
      this.#logger[level](`[gps-tracking] ${message}`);
    }
  }
}

export function createServer(options: ServerOptions): GpsServer {
  return new GpsServer(options);
}
