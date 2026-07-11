# Migrating from v1 to v2

**TL;DR: you probably don't need to change anything.** v2 ships a full
compatibility layer: the v1 API (`gps.server(...)`, snake_case events,
`login_authorized(true)`, custom v1 adapters) keeps working unchanged.
The only hard requirement is **Node.js >= 18.17**.

The v1 API is deprecated and will be removed in v3, so new code should use
the v2 API. Using any legacy entry point prints one `DeprecationWarning`
per process (silence it with `node --no-deprecation`).

## What you get by migrating

- TypeScript types for everything (events included).
- Proper TCP framing: positions no longer get lost/corrupted when packets
  arrive fragmented or coalesced (v1 assumed 1 socket event = 1 packet).
- No more crashes on `ECONNRESET` (v1 issue #12).
- Idle connections are cleaned up automatically (v1 issue #31).
- Zero runtime dependencies (v1 needed `crc`, `crc16-ccitt-node`,
  `node.extend` and an undeclared `crc-itu`).
- New protocols: SinoTrack ST-901 / H02 (`adapters.ST901`) and Concox
  GK309 (`adapters.GK309`), plus correct CRC handling for GT06.

## Side-by-side

v1:

```js
var gps = require('gps-tracking');

var server = gps.server({ port: 8090, device_adapter: 'TK103', debug: true }, function (device, connection) {
  device.on('login_request', function (device_id, msg_parts) {
    this.login_authorized(true);
  });
  device.on('ping', function (data) {
    console.log(data.latitude, data.longitude);
  });
  device.on('alarm', function (alarm_code, alarm_data, msg_data) {
    console.log(alarm_code);
  });
});
```

v2:

```ts
import { createServer, adapters } from 'gps-tracking';

const server = createServer({ port: 8090, adapter: adapters.TK103, logger: console });

server.on('connection', (device) => {
  device.on('loginRequest', () => device.acceptLogin());
  device.on('ping', (position) => console.log(position.latitude, position.longitude));
  device.on('alarm', (alarm) => console.log(alarm.code, alarm.message));
});

await server.listen();
```

## API mapping

| v1 (deprecated, still works)               | v2                                                     |
| ------------------------------------------ | ------------------------------------------------------ |
| `gps.server(opts, callback)`               | `createServer(opts)` + `server.on('connection', ...)`  |
| `device_adapter: 'TK103'` (string)         | `adapter: adapters.TK103` (class)                      |
| `device_adapter: require('./my-adapter')`  | subclass of `BaseAdapter` (see README)                 |
| `debug: true`                              | `logger: console`                                      |
| auto-listen on creation                    | `await server.listen()` (explicit)                     |
| `device.on('login_request', cb)`           | `device.on('loginRequest', cb)`                        |
| `device.login_authorized(true / false)`    | `device.acceptLogin()` / `device.rejectLogin()`        |
| `device.on('ping', (data) => ...)`         | same event, typed `GpsPosition` payload                |
| `device.on('alarm', (code, data, parts))`  | `device.on('alarm', (alarm, packet))`                  |
| `device.getUID()` / `device.setUID()`      | `device.id` (read-only)                                |
| `device.getName()` / `device.setName()`    | `device.name`                                          |
| `device.loged`                             | `device.isAuthenticated`                               |
| `device.set_refresh_time(i, d)`            | `device.setRefreshInterval(i, d)`                      |
| `server.find_device(id)`                   | `server.getDevice(id)`                                 |
| `server.send_to(id, msg)`                  | `server.sendTo(id, msg)`                               |
| `server.setDebug(v)` / `getDebug()`        | `logger` option                                        |
| `connection` callback argument             | `device.socket`                                        |

## Behaviour changes to be aware of

Even with the compat layer, a few things behave differently (for the better):

- **GT06/GT02A device ids** no longer include the leading `0` of the
  16-digit BCD field: you now get the plain 15-digit IMEI
  (`0123456789012345` → `123456789012345`). Update stored ids if needed.
- **TK510 dates** were read as `YYMMDD` in v1; the payload is RMC-style
  `DDMMYY` and v2 parses it accordingly. TK510 speeds are now converted
  from knots to km/h.
- **Position timestamps** are parsed as UTC `Date`s (v1 used the server's
  local timezone).
- **Corrupt frames** no longer throw strings that could crash the process:
  they emit a `parseError` event (or are discarded) and the connection
  keeps working.
- **GT06 acks** now echo the device's real serial number and use the
  correct CRC-16/X-25, so command responses work on real hardware
  (v1 sent a hardcoded ack that only matched serial 1).
- **Custom v1 adapters** run through a passthrough framer that preserves
  the v1 "1 socket event = 1 packet" behaviour, so they work exactly as
  before — but they don't benefit from the TCP fragmentation fix. Port
  them to `BaseAdapter` to get proper framing.
