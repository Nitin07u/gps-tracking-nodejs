import { DEFAULT_MAX_FRAME_LENGTH, EMPTY_BUFFER, type Framer } from './framer.js';

export interface DelimiterFramerOptions {
  /** Frame start byte, e.g. 0x28 `(` or 0x2a `*`. */
  start: number;
  /** Frame end byte, e.g. 0x29 `)` or 0x23 `#`. */
  end: number;
  /** Frames longer than this are discarded and the stream re-synced. Default 4096. */
  maxFrameLength?: number;
}

/**
 * Framer for text protocols delimited by single start/end bytes,
 * such as TK103 `(...)` and H02 `*...#`. Emitted frames include both
 * delimiter bytes. Bytes outside frames are discarded.
 */
export class DelimiterFramer implements Framer {
  readonly #start: number;
  readonly #end: number;
  readonly #maxFrameLength: number;
  #buffer: Buffer = EMPTY_BUFFER;

  constructor(options: DelimiterFramerOptions) {
    this.#start = options.start;
    this.#end = options.end;
    this.#maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
  }

  push(chunk: Buffer): Buffer[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: Buffer[] = [];

    for (;;) {
      const start = this.#buffer.indexOf(this.#start);
      if (start === -1) {
        this.#buffer = EMPTY_BUFFER;
        break;
      }
      if (start > 0) {
        this.#buffer = this.#buffer.subarray(start);
      }
      const end = this.#buffer.indexOf(this.#end, 1);
      if (end === -1) {
        if (this.#buffer.length > this.#maxFrameLength) {
          this.#buffer = EMPTY_BUFFER;
        }
        break;
      }
      if (end + 1 > this.#maxFrameLength) {
        // Oversized but terminated frame: discard it and keep going after it.
        this.#buffer = this.#buffer.subarray(end + 1);
        continue;
      }
      frames.push(this.#buffer.subarray(0, end + 1));
      this.#buffer = this.#buffer.subarray(end + 1);
    }

    return frames;
  }
}
