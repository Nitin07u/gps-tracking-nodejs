import type net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type GpsServer } from '../../src/server.js';
import type { Device } from '../../src/device.js';
import type { GpsPosition } from '../../src/types.js';
import { adapters } from '../../src/adapters/index.js';
import { connect, TK103_DEVICE_ID, TK103_LOGIN, TK103_PING } from '../helpers/tcp.js';

const servers: GpsServer[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function startServer(options: Partial<Parameters<typeof createServer>[0]> = {}) {
  const server = createServer({ adapter: adapters.TK103, port: 0, ...options });
  servers.push(server);
  const devices: Device[] = [];
  server.on('connection', (device) => {
    devices.push(device);
    device.on('loginRequest', () => device.acceptLogin());
  });
  const address = await server.listen();
  return { server, port: address.port, devices };
}

const track = (socket: net.Socket) => sockets.push(socket);

describe('GpsServer integration (real TCP)', () => {
  it('handles login → ack → ping end to end', async () => {
    const { server, port, devices } = await startServer();
    const client = await connect(port, track);

    const ack = once(client, 'data');
    client.write(TK103_LOGIN);
    expect(String((await ack)[0])).toBe(`(${TK103_DEVICE_ID}AP05)`);

    const device = devices[0]!;
    expect(device.isAuthenticated).toBe(true);
    expect(device.id).toBe(TK103_DEVICE_ID);
    expect(server.getDevice(TK103_DEVICE_ID)).toBe(device);

    const ping = once(device, 'ping');
    client.write(TK103_PING);
    const [position] = (await ping) as [GpsPosition];
    expect(position.latitude).toBeCloseTo(-33.5071467, 6);
  });

  it('reassembles positions that arrive fragmented over TCP', async () => {
    const { port, devices } = await startServer();
    const client = await connect(port, track);

    client.write(TK103_LOGIN);
    await once(client, 'data');

    const device = devices[0]!;
    const ping = once(device, 'ping');

    // One position split into 3 chunks plus the start of the next packet.
    client.write(TK103_PING.slice(0, 10));
    client.write(TK103_PING.slice(10, 40));
    client.write(TK103_PING.slice(40) + TK103_PING.slice(0, 5));
    const [position] = (await ping) as [GpsPosition];
    expect(position.latitude).toBeCloseTo(-33.5071467, 6);
  });

  it('discards data sent before login and asks nothing of the process', async () => {
    const { port, devices } = await startServer();
    const client = await connect(port, track);
    client.write(TK103_PING);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(devices[0]!.isAuthenticated).toBe(false);
  });

  it('survives an abrupt connection reset (issue #12)', async () => {
    const { port, devices } = await startServer();

    const client = await connect(port, track);
    client.write(TK103_LOGIN);
    await once(client, 'data');
    // RST instead of FIN: this used to crash the whole process in v1.
    // (manual promise: events.once() would reject on the device's 'error' event)
    const disconnected = new Promise<void>((resolve) => devices[0]!.once('disconnect', resolve));
    client.resetAndDestroy();
    await disconnected;

    // The server keeps accepting connections.
    const client2 = await connect(port, track);
    const ack = once(client2, 'data');
    client2.write(TK103_LOGIN);
    expect(String((await ack)[0])).toBe(`(${TK103_DEVICE_ID}AP05)`);
  });

  it('destroys idle connections after connectionTimeoutMs (issue #31)', async () => {
    const { server, port, devices } = await startServer({ connectionTimeoutMs: 100 });
    const client = await connect(port, track);
    client.write(TK103_LOGIN);
    await once(client, 'data');
    expect(server.devices.size).toBe(1);

    await once(devices[0]!, 'timeout');
    await once(server, 'disconnect');
    expect(server.devices.size).toBe(0);
  });

  it('emits parseError instead of crashing on garbage frames', async () => {
    const { port, devices } = await startServer();
    const client = await connect(port, track);
    client.write(TK103_LOGIN);
    await once(client, 'data');

    const parseError = once(devices[0]!, 'parseError');
    client.write('(nocommandhere-longer-than-12)');
    const [error] = (await parseError) as [Error];
    expect(error.name).toBe('PacketParseError');
  });

  it('sendTo() reaches the right device', async () => {
    const { server, port } = await startServer();
    const client = await connect(port, track);
    client.write(TK103_LOGIN);
    await once(client, 'data');

    const received = once(client, 'data');
    expect(server.sendTo(TK103_DEVICE_ID, 'hello')).toBe(true);
    expect(String((await received)[0])).toBe('hello');
    expect(server.sendTo('unknown-id', 'hello')).toBe(false);
  });
});
