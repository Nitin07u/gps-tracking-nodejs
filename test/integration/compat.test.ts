import type net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as gps from '../../src/index.js';
import type { LegacyServer, LegacyDevice } from '../../src/compat.js';
import { connect as tcpConnect, TK103_LOGIN as LOGIN, TK103_PING as PING } from '../helpers/tcp.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

function connect(port: number): Promise<net.Socket> {
  return tcpConnect(port, (socket) => {
    cleanups.push(() => {
      socket.destroy();
    });
  });
}

/** Boot a v1-style server (the README v1 example, verbatim API) on a random port. */
async function startLegacyServer(): Promise<{ server: LegacyServer; port: number; pings: unknown[] }> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const pings: unknown[] = [];

  // This is exactly the v1 README usage — snake_case events, `this.login_authorized(true)`.
  const server = gps.server({ debug: false, port: 0, device_adapter: 'TK103' }, function (device: LegacyDevice) {
    device.on('login_request', function (this: LegacyDevice, _deviceId: string, _msgParts: unknown) {
      this.login_authorized(true);
    });
    device.on('ping', function (data: unknown) {
      pings.push(data);
    });
  });
  cleanups.push(() => server.v2.close());

  const address = await new Promise<{ port: number }>((resolve) => server.v2.once('listening', resolve));
  return { server, port: address.port, pings };
}

describe('v1 compatibility layer', () => {
  it('runs the v1 README example unchanged (login + ping, snake_case events)', async () => {
    const { server, port, pings } = await startLegacyServer();
    const client = await connect(port);

    const ack = new Promise<Buffer>((resolve) => client.once('data', resolve));
    client.write(LOGIN);
    expect((await ack).toString()).toBe('(012341234123AP05)');

    client.write(PING);
    await vi.waitFor(() => expect(pings.length).toBe(1));

    const data = pings[0] as Record<string, unknown>;
    expect(data.latitude).toBeCloseTo(-33.5071467, 6);
    expect(data.longitude).toBeCloseTo(-70.6141967, 6);
    expect(data.from_cmd).toBe('BR00');

    // v1 server API
    const found = server.find_device('012341234123');
    expect(found).not.toBe(false);
    expect((found as LegacyDevice).getUID()).toBe('012341234123');
    expect((found as LegacyDevice).loged).toBe(true);
    expect(server.find_device('nope')).toBe(false);
    server.setDebug(true);
    expect(server.getDebug()).toBe(true);
  });

  it('exposes the v1 entry points (server function, version)', () => {
    expect(typeof gps.server).toBe('function');
    expect(typeof gps.version).toBe('string');
  });

  it('emits the DeprecationWarning exactly once per process', async () => {
    // Fresh module registry so this test observes the first legacy use,
    // regardless of what earlier tests in this worker already triggered.
    vi.resetModules();
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const freshGps = await import('../../src/index.js');

    const first = freshGps.server({ port: 0, device_adapter: 'TK103' });
    const second = freshGps.server({ port: 0, device_adapter: 'TK103' });
    cleanups.push(() => first.v2.close());
    cleanups.push(() => second.v2.close());

    const deprecations = emitWarning.mock.calls.filter((args) => (args[1] as unknown) === 'DeprecationWarning');
    expect(deprecations.length).toBe(1);
  });

  it('rejects unknown adapter names like v1 did', () => {
    expect(() => gps.server({ device_adapter: 'NOPE-3000', port: 0 })).toThrow(/doesn't exist/);
  });

  it('wraps legacy v1 custom adapter modules (parse_data / get_ping_data contract)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const authorized: string[] = [];

    // A minimal v1-style adapter module, as documented in the v1 README.
    const legacyModule = {
      protocol: 'TEST1',
      model_name: 'TEST-V1',
      adapter: function (device: { uid: string | undefined; send: (data: string) => void }) {
        return {
          parse_data(data: Buffer) {
            const text = data.toString();
            const [, id = '', action = '', payload = ''] = text.split('|');
            return { device_id: id, cmd: action, action, data: payload };
          },
          authorize() {
            authorized.push('yes');
            device.send('OK');
          },
          get_ping_data(parts: { data?: string }) {
            const [lat = '0', lng = '0'] = (parts.data ?? '').split(';');
            return { latitude: Number(lat), longitude: Number(lng), time: new Date(0) };
          },
        };
      },
    };

    const pings: unknown[] = [];
    const server = gps.server({ port: 0, device_adapter: legacyModule }, (device) => {
      device.on('login_request', function (this: LegacyDevice) {
        this.login_authorized(true);
      });
      device.on('ping', (data: unknown) => pings.push(data));
    });
    cleanups.push(() => server.v2.close());
    const { port } = await new Promise<{ port: number }>((resolve) => server.v2.once('listening', resolve));

    const client = await connect(port);
    const ack = new Promise<Buffer>((resolve) => client.once('data', resolve));
    client.write('|dev-9|login_request|');
    expect((await ack).toString()).toBe('OK');
    expect(authorized).toEqual(['yes']);

    client.write('|dev-9|ping|-33.5;-70.6');
    await vi.waitFor(() => expect(pings.length).toBe(1));
    expect((pings[0] as { latitude: number }).latitude).toBeCloseTo(-33.5);
  });
});
