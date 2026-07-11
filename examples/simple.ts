/**
 * Minimal v2 example: listen for TK103 devices on port 8090.
 * Run with: npx tsx examples/simple.ts
 */
import { createServer, adapters } from '../src/index.js';

const server = createServer({
  port: 8090,
  adapter: adapters.TK103,
  logger: console,
});

server.on('connection', (device) => {
  device.on('loginRequest', (deviceId) => {
    console.log(`Device ${deviceId} wants to log in`);
    device.acceptLogin(); // or device.rejectLogin({ disconnect: true })
  });

  device.on('ping', (position) => {
    console.log(`${device.id} is at ${position.latitude}, ${position.longitude} (${position.speed} km/h)`);
  });

  device.on('alarm', (alarm) => {
    console.log(`ALARM from ${device.id}: ${alarm.code} — ${alarm.message}`);
  });
});

const address = await server.listen();
console.log(`Listening on port ${address.port}`);
