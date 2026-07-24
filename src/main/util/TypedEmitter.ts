/**
 * A small strongly-typed event emitter.
 *
 * Preferred over the usual `declare interface Foo { on(...) }` trick, which
 * relies on unsafe declaration merging: the compiler cannot check that the
 * declared overloads match the class, so a typo in an event name still
 * compiles. Here the event map is the single source of truth for both `on`
 * and `emit`, and a wrong payload type is a compile error.
 *
 * Node's `EventEmitter` is wrapped rather than extended: its own signatures use
 * `any[]`, which cannot be narrowed by a generic subclass without variance
 * errors. Composition keeps the public surface fully typed.
 */

import { EventEmitter } from 'node:events';

export type EventMap = Record<string, readonly unknown[]>;

type Listener<Args extends readonly unknown[]> = (...args: Args) => void;

/** The erased shape Node's emitter actually stores. */
type ErasedListener = (...args: unknown[]) => void;

export class TypedEmitter<Events extends EventMap> {
  private readonly emitter = new EventEmitter();

  /** Subscribes to an event. */
  on<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): this {
    this.emitter.on(event, listener as unknown as ErasedListener);
    return this;
  }

  /** Subscribes for a single occurrence. */
  once<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): this {
    this.emitter.once(event, listener as unknown as ErasedListener);
    return this;
  }

  /** Unsubscribes a previously registered listener. */
  off<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): this {
    this.emitter.off(event, listener as unknown as ErasedListener);
    return this;
  }

  /** Emits an event. Payload types are checked against the event map. */
  emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    return this.emitter.emit(event, ...args);
  }

  removeAllListeners<K extends keyof Events & string>(event?: K): this {
    this.emitter.removeAllListeners(event);
    return this;
  }

  listenerCount<K extends keyof Events & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }

  /** Raises the listener ceiling; used only where many subscribers are expected. */
  setMaxListeners(count: number): this {
    this.emitter.setMaxListeners(count);
    return this;
  }
}
