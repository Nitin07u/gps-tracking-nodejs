import { Tk103Adapter } from './tk103.js';
import { Tk510Adapter } from './tk510.js';
import { Gt06Adapter, Gk309Adapter } from './gt06.js';
import { Gt02aAdapter } from './gt02a.js';
import { St901Adapter } from './st901.js';
import { ZxA50Adapter } from './zx-a50.js';

export { BaseAdapter, type AdapterClass } from './base-adapter.js';
export { Tk103Adapter, Tk510Adapter, Gt06Adapter, Gk309Adapter, Gt02aAdapter, St901Adapter, ZxA50Adapter };

/** Built-in adapters, keyed by model name. */
export const adapters = {
  TK103: Tk103Adapter,
  TK510: Tk510Adapter,
  GT06: Gt06Adapter,
  GT02A: Gt02aAdapter,
  GK309: Gk309Adapter,
  ST901: St901Adapter,
  /** Alias: the ST-901 adapter implements the generic H02 protocol. */
  H02: St901Adapter,
  ZX_A50: ZxA50Adapter,
} as const;
