/** Default cap for a single frame; larger data is treated as corrupt. */
export const DEFAULT_MAX_FRAME_LENGTH = 4096;

/** Shared zero-length buffer used by framers when their buffer drains. */
export const EMPTY_BUFFER: Buffer = Buffer.alloc(0);

/** Options every framer receives from the infrastructure. */
export interface FramerOptions {
  maxFrameLength: number;
}

/**
 * A Framer turns a TCP byte stream into complete protocol frames.
 * TCP gives no message boundaries: a single `data` event can hold half a
 * packet or three packets — the framer buffers and re-slices accordingly.
 */
export interface Framer {
  /** Feed a chunk from the socket; returns every complete frame now available. */
  push(chunk: Buffer): Buffer[];
}

/**
 * No framing: every chunk is assumed to be exactly one frame.
 * This replicates the (buggy) v1 behaviour and exists only so that
 * legacy v1 adapters keep working unchanged via the compat layer.
 */
export class PassthroughFramer implements Framer {
  push(chunk: Buffer): Buffer[] {
    return [chunk];
  }
}
