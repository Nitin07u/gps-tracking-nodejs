# GPS Tracking Server for Node.js

[![CI](https://github.com/freshworkstudio/gps-tracking-nodejs/actions/workflows/ci.yml/badge.svg)](https://github.com/freshworkstudio/gps-tracking-nodejs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gps-tracking.svg)](https://www.npmjs.com/package/gps-tracking)
[![License](https://img.shields.io/badge/license-MIT-brightgreen.svg)](LICENSE)

Create TCP listeners for GPS tracking devices in a few lines. Written in
TypeScript, zero runtime dependencies, dual ESM/CJS, Node.js >= 18.

```ts
import { createServer, adapters } from 'gps-tracking';

const server = createServer({ port: 8090, adapter: adapters.TK103 });

server.on('connection', (device) => {
  device.on('loginRequest', () => device.acceptLogin());

  device.on('ping', (position) => {
    console.log(`${device.id}: ${position.latitude}, ${position.longitude} @ ${position.speed} km/h`);
  });

  device.on('alarm', (alarm) => {
    console.log(`ALARM from ${device.id}: ${alarm.code} — ${alarm.message}`);
  });
});

await server.listen();
```

> **Coming from v1?** Your code still works unchanged — the whole v1 API
> (`gps.server(...)`, snake_case events) ships as a deprecated compatibility
> layer. See [MIGRATION.md](MIGRATION.md).

## Installation

```bash
npm install gps-tracking
```

## Supported devices

| Adapter            | Protocol | Devices                                             |
| ------------------ | -------- | --------------------------------------------------- |
| `adapters.TK103`   | GPS103   | TK103 and clones                                    |
| `adapters.GT06`    | GT06     | Concox GT06, GT06N and clones                       |
| `adapters.GK309`   | GT06     | Concox GK309, GK301, GK306                          |
| `adapters.ST901`   | H02      | SinoTrack ST-901 and other H02 devices (`adapters.H02` is an alias) |
| `adapters.GT02A`   | GT02     | GT02A                                               |
| `adapters.TK510`   | TK510    | TK510                                               |

Each server instance listens for **one** protocol. To support several device
models at once, run one server per protocol on different ports.

## How it works

1. `createServer({ port, adapter })` starts a TCP server for one protocol.
2. Every connection becomes a `Device` that emits typed events.
3. The adapter handles framing (TCP fragmentation included), parsing and
   protocol acks (login, heartbeats, alarms) automatically.

### Server options

```ts
createServer({
  adapter: adapters.GT06,     // required: adapter class
  port: 8090,                 // default 8090 (0 = random free port)
  host: '0.0.0.0',            // optional bind address
  connectionTimeoutMs: 120_000, // destroy idle connections (0 disables)
  maxFrameLength: 4096,       // discard corrupt/oversized frames
  logger: console,            // any {debug,info,warn,error}; default: silent
});
```

### Server API

```ts
const address = await server.listen(); // AddressInfo (address.port)
server.getDevice('865205035331981');   // Device | undefined
server.devices;                        // ReadonlyMap<string, Device>
server.sendTo('865205035331981', cmd); // boolean
await server.close();
```

Events: `listening`, `connection`, `disconnect`, `error`, `close`.

### Device API

```ts
device.id;               // IMEI / protocol id (undefined until identified)
device.isAuthenticated;  // true after acceptLogin (or first packet for H02)
device.acceptLogin();    // accept a pending loginRequest
device.rejectLogin({ disconnect: true });
device.send(data);       // raw Buffer | string to the device
device.setRefreshInterval(30, 3600); // when the protocol supports it
device.disconnect();
device.socket;           // the underlying net.Socket
```

Events: `loginRequest`, `login`, `identified`, `ping`, `alarm`, `packet`,
`parseError`, `error`, `timeout`, `disconnect`.

`ping` delivers a typed `GpsPosition`:

```ts
interface GpsPosition {
  latitude: number;
  longitude: number;
  time: Date;          // UTC
  valid?: boolean;     // GPS fix validity
  speed?: number;      // km/h
  orientation?: number; // degrees, north = 0
  mileage?: number;
  satellites?: number;
  extra?: Record<string, unknown>; // protocol-specific (LBS, ignition, ...)
}
```

## Writing a custom adapter

Extend `BaseAdapter`: choose a framer (how packets are delimited on the TCP
stream) and parse each frame into a `ParsedPacket`.

```ts
import { BaseAdapter, DelimiterFramer, PacketParseError } from 'gps-tracking';
import type { Framer, FramerOptions, ParsedPacket } from 'gps-tracking';

export class MyAdapter extends BaseAdapter {
  static override readonly protocol = 'MYPROTO';
  static override readonly modelName = 'MY-DEVICE';

  createFramer(options: FramerOptions): Framer {
    // Also available: LengthPrefixedFramer for binary marker+length protocols.
    return new DelimiterFramer({ start: 0x24, end: 0x0a, ...options }); // $ ... \n
  }

  parsePacket(frame: Buffer): ParsedPacket {
    const [id, cmd, payload] = frame.toString().slice(1, -1).split(',');
    if (!id || !cmd) throw new PacketParseError('malformed frame');

    if (cmd === 'LOGIN') return { cmd, raw: frame, action: 'loginRequest', deviceId: id };
    if (cmd === 'POS') {
      return {
        cmd, raw: frame, deviceId: id, action: 'ping',
        position: { latitude: 1, longitude: 2, time: new Date() /* parse payload */ },
      };
    }
    return { cmd, raw: frame, deviceId: id, action: 'other' };
  }

  authorize(): void {
    this.device.send('$OK\n'); // login ack
  }
}
```

Use it with `createServer({ adapter: MyAdapter, ... })`. Protocols without a
login handshake (like H02) can set `static override readonly requiresLogin = false`;
devices then authenticate automatically with their first valid packet.

Optional hooks: `requestLogin`, `ackPing`, `ackAlarm`, `ackHeartbeat`,
`handleCommand`, `setRefreshInterval`. One adapter instance is created per
connection, so instance fields are safe for per-connection state.

## GPS emulator

To test without hardware, check the companion emulator:
[freshworkstudio/gps-tracking-emulator](https://github.com/freshworkstudio/gps-tracking-emulator)

## Contributing

```bash
npm install
npm test          # vitest (unit + TCP integration)
npm run typecheck
npm run lint
npm run build     # tsup → dist (ESM + CJS + types)
```

Protocol fixtures in `test/` come from official protocol documents
(Concox GK309 V1.8, HuaSunTeK H02 V1.0.5) and real captured packets — please
include fixtures with new adapters.

## License

[MIT](LICENSE)
