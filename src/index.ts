export { createServer, GpsServer } from './server.js';
export { Device, type DeviceOptions } from './device.js';
export {
  adapters,
  BaseAdapter,
  Tk103Adapter,
  Tk510Adapter,
  Gt06Adapter,
  Gk309Adapter,
  Gt02aAdapter,
  St901Adapter,
  type AdapterClass,
} from './adapters/index.js';
export { type Framer, type FramerOptions, PassthroughFramer, DEFAULT_MAX_FRAME_LENGTH } from './framing/framer.js';
export { DelimiterFramer, type DelimiterFramerOptions } from './framing/delimiter-framer.js';
export {
  LengthPrefixedFramer,
  type LengthPrefixedFramerOptions,
  type FrameMarker,
} from './framing/length-prefixed-framer.js';
export { GpsTrackingError, PacketParseError, AdapterError, NotSupportedError } from './errors.js';
export { crc16X25 } from './lib/crc.js';
export { minuteToDecimal, minutes30000ToDegrees, getDistance, KNOTS_TO_KMH, type LatLng } from './lib/geo.js';
export type {
  GpsPosition,
  Alarm,
  ParsedPacket,
  PacketBase,
  Logger,
  ServerOptions,
  ServerEvents,
  DeviceEvents,
} from './types.js';

// v1 compatibility layer (deprecated).
export {
  server,
  LegacyServer,
  LegacyDevice,
  type LegacyServerOptions,
  type LegacyAdapterModule,
} from './compat.js';

export const version = '2.0.0-beta.1';
