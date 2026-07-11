import { describe, expect, it } from 'vitest';
import { DelimiterFramer } from '../../src/framing/delimiter-framer.js';
import { LengthPrefixedFramer } from '../../src/framing/length-prefixed-framer.js';
import { GT06_FRAME_MARKERS } from '../../src/adapters/gt06.js';

/** Feed `stream` split at every possible byte position and assert identical frames. */
function assertAllSplits(makeFramer: () => { push(chunk: Buffer): Buffer[] }, stream: Buffer, expected: Buffer[]) {
  for (let splitAt = 1; splitAt < stream.length; splitAt++) {
    const framer = makeFramer();
    const frames = [...framer.push(stream.subarray(0, splitAt)), ...framer.push(stream.subarray(splitAt))];
    expect(frames.map((f) => f.toString('hex'))).toEqual(expected.map((f) => f.toString('hex')));
  }
}

describe('DelimiterFramer', () => {
  const frameA = Buffer.from('(012341234123BR00ABC)');
  const frameB = Buffer.from('(012341234123BP05XYZ)');

  it('emits one frame per packet when packets arrive whole', () => {
    const framer = new DelimiterFramer({ start: 0x28, end: 0x29 });
    expect(framer.push(frameA)).toEqual([frameA]);
  });

  it('handles coalesced packets in a single chunk', () => {
    const framer = new DelimiterFramer({ start: 0x28, end: 0x29 });
    expect(framer.push(Buffer.concat([frameA, frameB]))).toEqual([frameA, frameB]);
  });

  it('reassembles fragmented packets split at every byte position', () => {
    assertAllSplits(
      () => new DelimiterFramer({ start: 0x28, end: 0x29 }),
      Buffer.concat([frameA, frameB]),
      [frameA, frameB],
    );
  });

  it('discards garbage between frames', () => {
    const framer = new DelimiterFramer({ start: 0x28, end: 0x29 });
    const stream = Buffer.concat([Buffer.from('\r\nnoise'), frameA, Buffer.from('\r\n'), frameB, Buffer.from('..')]);
    expect(framer.push(stream)).toEqual([frameA, frameB]);
  });

  it('re-syncs when a frame exceeds maxFrameLength', () => {
    const framer = new DelimiterFramer({ start: 0x28, end: 0x29, maxFrameLength: 8 });
    expect(framer.push(Buffer.from('(waaaaaaaaaaaaaaytoolong'))).toEqual([]);
    expect(framer.push(frameA)).toEqual([frameA]);
  });
});

describe('LengthPrefixedFramer', () => {
  const login = Buffer.from('78780F01025241903071152410050001F3D70D0A', 'hex');
  const gps = Buffer.from('787819100B03110A100FCF027AC8570C4657350014000001000452830D0A', 'hex');

  it('emits one frame per packet when packets arrive whole', () => {
    const framer = new LengthPrefixedFramer({ markers: GT06_FRAME_MARKERS });
    expect(framer.push(login)).toEqual([login]);
  });

  it('handles coalesced packets in a single chunk', () => {
    const framer = new LengthPrefixedFramer({ markers: GT06_FRAME_MARKERS });
    expect(framer.push(Buffer.concat([login, gps]))).toEqual([login, gps]);
  });

  it('reassembles fragmented packets split at every byte position', () => {
    assertAllSplits(
      () => new LengthPrefixedFramer({ markers: GT06_FRAME_MARKERS }),
      Buffer.concat([login, gps]),
      [login, gps],
    );
  });

  it('discards garbage before a marker', () => {
    const framer = new LengthPrefixedFramer({ markers: GT06_FRAME_MARKERS });
    expect(framer.push(Buffer.concat([Buffer.from('deadbeef', 'hex'), gps]))).toEqual([gps]);
  });

  it('re-syncs after a corrupt length field', () => {
    const framer = new LengthPrefixedFramer({ markers: GT06_FRAME_MARKERS, maxFrameLength: 64 });
    // 0x7878 followed by an absurd length, then a valid frame.
    expect(framer.push(Buffer.concat([Buffer.from('7878ff', 'hex'), gps]))).toEqual([gps]);
  });

  it('waits for more data when the length field itself is incomplete', () => {
    const framer = new LengthPrefixedFramer({ markers: GT06_FRAME_MARKERS });
    expect(framer.push(Buffer.from('7878', 'hex'))).toEqual([]);
    expect(framer.push(login.subarray(2))).toEqual([login]);
  });
});
