export class GpsTrackingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A frame could not be parsed by the adapter. Emitted as a `parseError` event, never thrown to the process. */
export class PacketParseError extends GpsTrackingError {}

/** An adapter was misconfigured or returned invalid data. */
export class AdapterError extends GpsTrackingError {}

/** The protocol/adapter does not support the requested operation. */
export class NotSupportedError extends GpsTrackingError {}
