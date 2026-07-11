import type { Device } from '../../src/device.js';

/**
 * Minimal Device stand-in for unit-testing adapters:
 * captures everything the adapter sends and exposes a settable id.
 */
export function fakeDevice(id?: string) {
  const sent: (Buffer | string)[] = [];
  const device = {
    id,
    send(data: Buffer | string): boolean {
      sent.push(data);
      return true;
    },
  } as unknown as Device;
  return { device, sent };
}

export function sentAsStrings(sent: (Buffer | string)[]): string[] {
  return sent.map((item) => (typeof item === 'string' ? item : item.toString('hex')));
}
