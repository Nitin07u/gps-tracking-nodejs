/**
 * v1 compatibility layer.
 *
 * Everything in this file is deprecated: it exists so that code written for
 * gps-tracking v1 keeps working unchanged on v2. See MIGRATION.md for the
 * modern equivalents. The first use of any legacy API emits one
 * DeprecationWarning per process (silence with `node --no-deprecation`).
 */
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { createServer, type GpsServer } from './server.js';
import type { Device } from './device.js';
import { BaseAdapter, type AdapterClass } from './adapters/base-adapter.js';
import { adapters } from './adapters/index.js';
import { PassthroughFramer, type Framer, type FramerOptions } from './framing/framer.js';

type LegacySocket = Socket & { device?: LegacyDevice };
import { AdapterError, PacketParseError } from './errors.js';
import type { Alarm, GpsPosition, ParsedPacket } from './types.js';

let warned = false;
function warnDeprecated(): void {
  if (!warned) {
    warned = true;
    process.emitWarning(
      'The gps-tracking v1 API (gps.server(...), snake_case events) is deprecated and will be removed in v3. ' +
        'See https://github.com/freshworkstudio/gps-tracking-nodejs/blob/master/MIGRATION.md',
      'DeprecationWarning',
    );
  }
}

/** Shape of a v1 adapter module: `{ adapter, protocol, model_name, compatible_hardware }`. */
export interface LegacyAdapterModule {
  adapter: (device: LegacyAdapterDevice) => LegacyAdapterInstance;
  protocol?: string;
  model_name?: string;
  compatible_hardware?: string[];
}

/** The `device` façade handed to v1 adapter instances. */
export interface LegacyAdapterDevice {
  uid: string | undefined;
  send(data: Buffer | string): void;
}

export interface LegacyAdapterInstance {
  parse_data(data: Buffer): LegacyMsgParts | false;
  authorize(msgParts?: LegacyMsgParts): void;
  get_ping_data?(msgParts: LegacyMsgParts): Record<string, unknown> | false;
  receive_alarm?(msgParts: LegacyMsgParts): { code: string; msg?: string } | false;
  run_other?(cmd: string, msgParts: LegacyMsgParts): void;
  request_login_to_device?(): void;
  set_refresh_time?(interval: number, duration: number): void;
}

export interface LegacyMsgParts {
  device_id?: string;
  cmd: string;
  action?: string;
  data?: string;
  [key: string]: unknown;
}

export interface LegacyServerOptions {
  debug?: boolean;
  port?: number;
  device_adapter?: string | LegacyAdapterModule | AdapterClass | false;
  [key: string]: unknown;
}

/** Wraps a v1 adapter module so it satisfies the v2 BaseAdapter contract. */
function wrapLegacyAdapter(module: LegacyAdapterModule): AdapterClass {
  if (typeof module.adapter !== 'function') {
    throw new AdapterError('The adapter needs an adapter() method to start an instance of it');
  }

  class LegacyAdapterWrapper extends BaseAdapter {
    static override readonly protocol = module.protocol ?? 'legacy';
    static override readonly modelName = module.model_name ?? 'legacy';
    static override readonly compatibleHardware = module.compatible_hardware ?? [];

    #instance: LegacyAdapterInstance;
    #lastParts: LegacyMsgParts | undefined;
    #pendingLoginParts: LegacyMsgParts | undefined;

    constructor(device: Device) {
      super(device);
      const facade: LegacyAdapterDevice = {
        get uid() {
          return device.id;
        },
        send: (data) => device.send(data),
      };
      // v1 adapters were factory functions that also worked with `new`.
      this.#instance = module.adapter(facade);
    }

    createFramer(_options: FramerOptions): Framer {
      // v1 had no framing: one 'data' event was assumed to be one packet.
      // Preserved for legacy adapters; built-in v2 adapters do frame properly.
      return new PassthroughFramer();
    }

    parsePacket(frame: Buffer): ParsedPacket {
      const parts = this.#instance.parse_data(frame);
      if (parts === false) {
        throw new PacketParseError('legacy adapter parse_data() returned false');
      }
      if (typeof parts.cmd === 'undefined') {
        throw new PacketParseError("The adapter doesn't return the command (cmd) parameter");
      }
      this.#lastParts = parts;
      const base = {
        cmd: parts.cmd,
        deviceId: parts.device_id,
        data: typeof parts.data === 'string' ? parts.data : undefined,
        raw: frame,
      };

      switch (parts.action) {
        case 'login_request':
          if (!parts.device_id) {
            throw new PacketParseError("The adapter doesn't return the device_id");
          }
          // Kept separately: frames parsed while the login is pending (e.g. a
          // heartbeat before acceptLogin) must not become the authorize() payload.
          this.#pendingLoginParts = parts;
          return { ...base, action: 'loginRequest', deviceId: parts.device_id };
        case 'ping': {
          const gps = this.#instance.get_ping_data?.(parts);
          if (!gps) {
            throw new PacketParseError("GPS Data can't be parsed");
          }
          return { ...base, action: 'ping', position: legacyGpsToPosition(gps) };
        }
        case 'alarm': {
          const alarm = this.#instance.receive_alarm?.(parts);
          if (!alarm) {
            throw new PacketParseError("Alarm data can't be parsed");
          }
          return { ...base, action: 'alarm', alarm: { code: alarm.code, message: alarm.msg ?? alarm.code } };
        }
        default:
          return { ...base, action: 'other' };
      }
    }

    authorize(): void {
      const loginParts = this.#pendingLoginParts;
      this.#pendingLoginParts = undefined;
      this.#instance.authorize(loginParts ?? this.#lastParts);
    }

    override requestLogin(): void {
      this.#instance.request_login_to_device?.();
    }

    override handleCommand(packet: ParsedPacket): void {
      if (this.#lastParts) {
        this.#instance.run_other?.(packet.cmd, this.#lastParts);
      }
    }

    override setRefreshInterval(intervalSeconds: number, durationSeconds: number): void {
      this.#instance.set_refresh_time?.(intervalSeconds, durationSeconds);
    }
  }

  return LegacyAdapterWrapper;
}

function legacyGpsToPosition(gps: Record<string, unknown>): GpsPosition {
  const { latitude, longitude, time, speed, orientation, mileage, ...extra } = gps;
  return {
    latitude: Number(latitude),
    longitude: Number(longitude),
    time: time instanceof Date ? time : new Date(),
    speed: speed !== undefined ? Number(speed) : undefined,
    orientation: orientation !== undefined ? Number(orientation) : undefined,
    mileage: mileage !== undefined ? Number(mileage) : undefined,
    extra,
  };
}

function legacyParts(packet: ParsedPacket): LegacyMsgParts {
  return {
    device_id: packet.deviceId,
    cmd: packet.cmd,
    data: packet.data,
    action: packet.action,
  };
}

/**
 * @deprecated v1 device wrapper. Use the v2 {@link Device} (`server.on('connection', device => ...)`).
 */
export class LegacyDevice extends EventEmitter {
  /** The v2 device, if you want to migrate gradually. */
  readonly v2: Device;
  uid: string | undefined;
  name: string | false = false;
  readonly ip: string | undefined;
  readonly port: number | undefined;

  constructor(device: Device) {
    super();
    this.v2 = device;
    this.uid = device.id;
    this.ip = device.remoteAddress;
    this.port = device.remotePort;

    device.on('identified', (id) => {
      this.uid = id;
    });
    device.on('loginRequest', (deviceId, packet) => {
      this.emit('login_request', deviceId, legacyParts(packet));
    });
    device.on('login', () => this.emit('login'));
    device.on('ping', (position, packet) => {
      const { extra, ...core } = position;
      this.emit('ping', { ...core, ...extra, from_cmd: packet.cmd }, legacyParts(packet));
    });
    device.on('alarm', (alarm: Alarm, packet) => {
      this.emit('alarm', alarm.code, { ...alarm, msg: alarm.message }, legacyParts(packet));
    });
  }

  get loged(): boolean {
    return this.v2.isAuthenticated;
  }

  /** @deprecated Use `device.acceptLogin()` / `device.rejectLogin()`. */
  login_authorized(val: boolean): void {
    if (val) {
      this.v2.acceptLogin();
    } else {
      this.v2.rejectLogin();
    }
  }

  /** @deprecated Use `device.disconnect()`. */
  logout(): void {
    this.v2.rejectLogin();
  }

  /** @deprecated Use `device.send()`. */
  send(msg: Buffer | string): void {
    this.emit('send_data', msg);
    this.v2.send(msg);
  }

  /** @deprecated Use `device.setRefreshInterval()`. */
  set_refresh_time(interval: number, duration: number): void {
    this.v2.setRefreshInterval(interval, duration);
  }

  /** @deprecated Use `device.id`. */
  getUID(): string | false {
    return this.uid ?? false;
  }

  /** @deprecated The v2 device id is read-only. */
  setUID(uid: string): void {
    this.uid = uid;
  }

  /** @deprecated Use `device.name`. */
  getName(): string | false {
    return this.name;
  }

  /** @deprecated Use `device.name`. */
  setName(name: string): void {
    this.name = name;
    this.v2.name = name;
  }

  /** @deprecated Pass a `logger` to createServer instead. */
  do_log(msg: string): void {
    console.log(`#${this.uid ?? '?'}: ${msg}`);
  }
}

/**
 * @deprecated v1 server wrapper returned by {@link server}. Use {@link createServer}.
 */
export class LegacyServer extends EventEmitter {
  /** The v2 server, if you want to migrate gradually. */
  readonly v2: GpsServer;
  /** @deprecated v1-style list of connections (`net.Socket`s with a `.device` property). */
  readonly devices: Socket[] = [];
  #debug: boolean;

  constructor(gpsServer: GpsServer, options: LegacyServerOptions, callback?: (device: LegacyDevice, connection: Socket) => void) {
    super();
    this.v2 = gpsServer;
    this.#debug = options.debug === true;

    gpsServer.on('connection', (device) => {
      const legacyDevice = new LegacyDevice(device);
      const socket = device.socket as LegacySocket;
      socket.device = legacyDevice;
      this.devices.push(socket);
      callback?.(legacyDevice, socket);
      legacyDevice.emit('connected');
    });
    gpsServer.on('disconnect', (device) => {
      const socket = device.socket as LegacySocket;
      const index = this.devices.indexOf(socket);
      if (index !== -1) {
        this.devices.splice(index, 1);
      }
      socket.device?.emit('disconnected');
    });
  }

  /** @deprecated Use `server.getDevice(id)`. */
  find_device(deviceId: string): LegacyDevice | false {
    const device = this.v2.getDevice(deviceId);
    if (!device) {
      return false;
    }
    return (device.socket as LegacySocket).device ?? false;
  }

  /** @deprecated Use `server.sendTo(id, data)`. */
  send_to(deviceId: string, msg: Buffer | string): void {
    this.v2.sendTo(deviceId, msg);
  }

  /** @deprecated Pass a `logger` to createServer instead. */
  setDebug(val: boolean): void {
    this.#debug = val === true;
  }

  /** @deprecated */
  getDebug(): boolean {
    return this.#debug;
  }

  /** @deprecated */
  do_log(msg: string, from = 'SERVER'): void {
    if (this.#debug) {
      console.log(`#${from}: ${msg}`);
    }
  }
}

function resolveAdapter(deviceAdapter: LegacyServerOptions['device_adapter']): AdapterClass {
  if (!deviceAdapter) {
    throw new AdapterError(
      "The app don't set the device_adapter to use. Which model is sending data to this server?",
    );
  }
  if (typeof deviceAdapter === 'string') {
    const adapterClass = (adapters as Record<string, AdapterClass>)[deviceAdapter.toUpperCase()];
    if (!adapterClass) {
      throw new AdapterError(`The class adapter for ${deviceAdapter} doesn't exist`);
    }
    return adapterClass;
  }
  if (typeof deviceAdapter === 'function') {
    return deviceAdapter;
  }
  return wrapLegacyAdapter(deviceAdapter);
}

/**
 * @deprecated v1 entry point, kept for backwards compatibility.
 * Use {@link createServer} instead:
 * ```ts
 * const server = createServer({ port: 8090, adapter: adapters.TK103 });
 * server.on('connection', device => { ... });
 * await server.listen();
 * ```
 */
export function server(
  options: LegacyServerOptions,
  callback?: (device: LegacyDevice, connection: Socket) => void,
): LegacyServer {
  warnDeprecated();
  const adapterClass = resolveAdapter(options.device_adapter);
  const gpsServer = createServer({
    adapter: adapterClass,
    port: options.port ?? 8080,
    logger: options.debug === true ? console : false,
  });
  const legacy = new LegacyServer(gpsServer, options, callback);
  gpsServer
    .listen()
    .then(({ port }) => {
      console.log(
        `\n=================================================\nGPS LISTENER running at port ${port}\nEXPECTING DEVICE MODEL: ${adapterClass.modelName}\n=================================================\n`,
      );
    })
    .catch((error: Error) => {
      if (legacy.listenerCount('error') > 0) {
        legacy.emit('error', error);
      } else {
        throw error;
      }
    });
  return legacy;
}
