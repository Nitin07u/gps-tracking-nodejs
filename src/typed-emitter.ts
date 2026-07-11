/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-unused-vars --
 * Class/interface declaration merging is the standard way to narrow EventEmitter's
 * signatures without a runtime wrapper (same pattern as tiny-typed-emitter). */
import { EventEmitter } from 'node:events';

export type EventMap = Record<string, unknown[]>;

/**
 * EventEmitter with typed event names and listener signatures.
 * Runtime behaviour is exactly Node's EventEmitter; only the types are narrowed.
 */
export class TypedEmitter<T extends EventMap = EventMap> extends EventEmitter {}

export interface TypedEmitter<T extends EventMap = EventMap> {
  on<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this;
  once<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this;
  off<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this;
  addListener<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this;
  removeListener<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this;
  emit<K extends keyof T & string>(event: K, ...args: T[K]): boolean;
}
