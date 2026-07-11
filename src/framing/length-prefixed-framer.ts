import { DEFAULT_MAX_FRAME_LENGTH, EMPTY_BUFFER, type Framer } from './framer.js';

export interface FrameMarker {
  /** Start-of-frame marker bytes, e.g. Buffer 0x78 0x78. */
  marker: Buffer;
  /** Byte offset of the length field, from the start of the frame. */
  lengthOffset: number;
  /** Size of the length field (big-endian when 2). */
  lengthBytes: 1 | 2;
  /** Total frame length in bytes as a function of the length-field value. */
  totalLength: (length: number) => number;
}

export interface LengthPrefixedFramerOptions {
  markers: readonly FrameMarker[];
  /** Frames longer than this are treated as corrupt; the stream re-syncs. Default 4096. */
  maxFrameLength?: number;
}

/**
 * Framer for binary protocols with a start marker and a length field,
 * such as GT06/GK309 (0x7878 / 0x7979), GT02A (0x6868) and TK510 (0x4040).
 * Bytes before a marker are discarded; corrupt lengths skip the marker to re-sync.
 */
export class LengthPrefixedFramer implements Framer {
  readonly #markers: readonly FrameMarker[];
  readonly #maxFrameLength: number;
  readonly #maxMarkerLength: number;
  #buffer: Buffer = EMPTY_BUFFER;

  constructor(options: LengthPrefixedFramerOptions) {
    this.#markers = options.markers;
    this.#maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
    this.#maxMarkerLength = Math.max(...options.markers.map((m) => m.marker.length));
  }

  push(chunk: Buffer): Buffer[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: Buffer[] = [];

    for (;;) {
      const found = this.#findMarker();
      if (!found) {
        // Keep a marker-length tail in case a marker straddles two chunks.
        if (this.#buffer.length > this.#maxMarkerLength - 1) {
          this.#buffer = this.#buffer.subarray(this.#buffer.length - (this.#maxMarkerLength - 1));
        }
        break;
      }
      const { marker, index } = found;
      if (index > 0) {
        this.#buffer = this.#buffer.subarray(index);
      }
      if (this.#buffer.length < marker.lengthOffset + marker.lengthBytes) {
        break;
      }
      const length =
        marker.lengthBytes === 1
          ? this.#buffer.readUInt8(marker.lengthOffset)
          : this.#buffer.readUInt16BE(marker.lengthOffset);
      const total = marker.totalLength(length);
      if (total <= marker.marker.length || total > this.#maxFrameLength) {
        // Corrupt length: skip one byte past the marker start to re-sync.
        this.#buffer = this.#buffer.subarray(1);
        continue;
      }
      if (this.#buffer.length < total) {
        break;
      }
      frames.push(this.#buffer.subarray(0, total));
      this.#buffer = this.#buffer.subarray(total);
    }

    return frames;
  }

  #findMarker(): { marker: FrameMarker; index: number } | undefined {
    let best: { marker: FrameMarker; index: number } | undefined;
    for (const marker of this.#markers) {
      const index = this.#buffer.indexOf(marker.marker);
      if (index !== -1 && (best === undefined || index < best.index)) {
        best = { marker, index };
      }
    }
    return best;
  }
}
