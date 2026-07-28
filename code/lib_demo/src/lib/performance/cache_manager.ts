import { CacheEntry, type CacheTier } from "./cache_entry";
import { DoubleLinkedList } from "./double_linked_list";

/** Lifecycle callback: the only seam between the generic cache and its caller. */
export type CacheCallback<T> = (key: string, value: T) => void;

export interface CacheManagerOptions<T> {
  /** Total memory budget in bytes. */
  budgetBytes: number;
  /** Called with (key, value) before an entry is removed. */
  onEvict?: CacheCallback<T>;
  /**
   * Called on warm → rendered, and when a rendered entry's value is updated
   * (so the caller can push the new value to its renderer without a second call).
   */
  onPromote?: CacheCallback<T>;
  /** Called on rendered → warm. */
  onDemote?: CacheCallback<T>;
}

/**
 * Generic, domain-agnostic LRU cache with a two-queue tier system.
 *
 * Tier model:
 *   Cold     — absence of an entry (has() === false). Not a cache state.
 *   Warm     — fetched & in JS memory, not yet rendered. Eviction candidates.
 *   Rendered — actively in use by the caller. Protected from eviction.
 *
 * The two-queue design keeps warm and rendered entries in separate DLLs,
 * making eviction O(1) regardless of how many rendered entries exist.
 *
 * This class has zero domain knowledge. It never inspects values, never fetches,
 * and never decides what gets rendered. All domain logic belongs in the caller,
 * reached only through the `onEvict` / `onPromote` / `onDemote` callbacks.
 *
 * @typeParam T - The cached payload type. The cache is parametric in it and
 *                never inspects it, which is what lets a domain layer get full
 *                typing at the seam while this layer stays domain-blind.
 */
export class CacheManager<T = unknown> {
  #map: Map<string, CacheEntry<T>>; // O(1) lookup
  #warmList: DoubleLinkedList<CacheEntry<T>>; // eviction candidates (LRU order)
  #renderedList: DoubleLinkedList<CacheEntry<T>>; // protected entries (LRU order)
  #pending: Map<string, Promise<unknown>>; // in-flight fetches, keyed same as #map

  #currentBytes = 0;
  #budgetBytes: number;

  #onEvict?: CacheCallback<T>;
  #onPromote?: CacheCallback<T>;
  #onDemote?: CacheCallback<T>;

  constructor({ budgetBytes, onEvict, onPromote, onDemote }: CacheManagerOptions<T>) {
    this.#budgetBytes = budgetBytes;
    this.#onEvict = onEvict;
    this.#onPromote = onPromote;
    this.#onDemote = onDemote;

    this.#map = new Map();
    this.#warmList = new DoubleLinkedList();
    this.#renderedList = new DoubleLinkedList();
    this.#pending = new Map();
  }

  /** Bytes currently occupied. */
  get currentBytes(): number {
    return this.#currentBytes;
  }
  /** Maximum allowed bytes. */
  get budgetBytes(): number {
    return this.#budgetBytes;
  }
  /** Warm + rendered combined. */
  get entryCount(): number {
    return this.#map.size;
  }
  /** Eviction candidates. */
  get warmCount(): number {
    return this.#warmList.size;
  }
  /** Protected from eviction. */
  get renderedCount(): number {
    return this.#renderedList.size;
  }

  /** Returns true if the key exists in cache (warm or rendered). */
  has(key: string): boolean {
    return this.#map.has(key);
  }

  /**
   * Returns the cached value and moves the entry to the front of its tier queue.
   * Returns null on miss.
   */
  get(key: string): T | null {
    const entry = this.#map.get(key);
    if (!entry) return null;
    this.#listFor(entry.tier).moveToFront(entry);
    return entry.value;
  }

  /**
   * Inserts or updates an entry at Warm tier.
   * If the entry is currently rendered, fires onPromote so the caller can
   * push the updated value to its renderer.
   * Triggers the eviction loop after insert if over budget.
   *
   * @throws RangeError if sizeBytes alone exceeds the total budget.
   */
  set(key: string, value: T, sizeBytes: number): void {
    if (sizeBytes > this.#budgetBytes) {
      throw new RangeError(
        `Entry "${key}" (${sizeBytes}B) exceeds total budget (${this.#budgetBytes}B)`
      );
    }

    this.#updateOrCreate(key, value, sizeBytes);
    this.#currentBytes += sizeBytes;
    this.#runEviction();
  }

  /** Removes an entry regardless of tier. No-op if the key is not found. */
  delete(key: string): void {
    const entry = this.#map.get(key);
    if (!entry) return;

    this.#listFor(entry.tier).remove(entry);
    this.#map.delete(key);
    this.#currentBytes -= entry.sizeBytes;
  }

  /**
   * Promotes an entry from warm → rendered.
   * Fires onPromote. No-op if already rendered or not found.
   */
  promote(key: string): void {
    const entry = this.#map.get(key);
    if (!entry || entry.tier === "rendered") return;

    this.#warmList.remove(entry);
    entry.tier = "rendered";
    this.#renderedList.pushFront(entry);
    this.#onPromote?.(key, entry.value);
  }

  /**
   * Demotes an entry from rendered → warm.
   * Pushes to the front of warmList — recently demoted entries stay hot
   * for fast re-promote without a fetch. Fires onDemote.
   * No-op if already warm or not found.
   */
  demote(key: string): void {
    const entry = this.#map.get(key);
    if (!entry || entry.tier === "warm") return;

    this.#renderedList.remove(entry);
    entry.tier = "warm";
    this.#warmList.pushFront(entry);
    this.#onDemote?.(key, entry.value);
  }

  /** Returns true if a fetch for this key is currently in-flight. */
  isPending(key: string): boolean {
    return this.#pending.has(key);
  }

  /**
   * Registers a promise against a key to prevent duplicate fetches.
   * Auto-cleans on settle (resolve or reject).
   * Returns the promise for chaining.
   */
  registerPending<P extends Promise<unknown>>(key: string, promise: P): P {
    this.#pending.set(key, promise);
    // Use then(onFulfilled, onRejected) rather than finally(): finally() derives
    // a NEW promise that re-throws the rejection, and since nothing awaits that
    // derived chain, a failed fetch would surface as an unhandled rejection
    // (console noise in a browser, a hard crash under
    // `--unhandled-rejections=throw`). Handling both outcomes here keeps our
    // bookkeeping branch settled; the caller still gets the original promise,
    // rejection intact, and remains responsible for handling it.
    const cleanup = () => this.#pending.delete(key);
    promise.then(cleanup, cleanup);
    return promise;
  }

  /** Fully resets the cache. Useful for logout, tree switching, or testing. */
  clear(): void {
    this.#map.clear();
    this.#pending.clear();
    this.#warmList = new DoubleLinkedList();
    this.#renderedList = new DoubleLinkedList();
    this.#currentBytes = 0;
  }

  /** Returns the correct DLL for a given tier. */
  #listFor(tier: CacheTier): DoubleLinkedList<CacheEntry<T>> {
    return tier === "rendered" ? this.#renderedList : this.#warmList;
  }

  /**
   * Updates an existing entry in place, or creates a new one at warm tier.
   * Subtracts the old sizeBytes before the caller adds the new one, keeping
   * #currentBytes consistent across the set() call.
   * Fires onPromote if the updated entry is currently rendered, so the caller
   * can push the new value to its renderer without a separate promote() call.
   */
  #updateOrCreate(key: string, value: T, sizeBytes: number): void {
    const existing = this.#map.get(key);
    if (existing) {
      this.#currentBytes -= existing.sizeBytes; // caller adds the new size after
      existing.value = value;
      existing.sizeBytes = sizeBytes;
      this.#listFor(existing.tier).moveToFront(existing);
      if (existing.tier === "rendered") this.#onPromote?.(key, existing.value);
    } else {
      const entry = new CacheEntry(key, value, sizeBytes);
      this.#map.set(key, entry);
      this.#warmList.pushFront(entry);
    }
  }

  /**
   * Eviction loop — runs after every insert.
   * Evicts warm tail entries first; only touches renderedList as a last resort.
   * Uses popTail() for true O(1) eviction — no scanning.
   * Fires onEvict before removal so the caller can clean up.
   */
  #runEviction(): void {
    while (this.#currentBytes > this.#budgetBytes) {
      const candidate = this.#warmList.popTail() ?? this.#renderedList.popTail();
      if (!candidate) break; // empty cache — shouldn't happen

      this.#onEvict?.(candidate.key, candidate.value);
      this.#map.delete(candidate.key);
      this.#currentBytes -= candidate.sizeBytes;
    }
  }
}
