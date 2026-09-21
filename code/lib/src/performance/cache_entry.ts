/**
 * Which tier an entry currently occupies.
 *
 * `Cold` is deliberately absent: it is the *absence* of an entry
 * (`CacheManager.has(key) === false`), not a state an entry can be in.
 */
export type CacheTier = "warm" | "rendered";

/**
 * A single cache entry designed to live simultaneously in two data structures:
 *   - CacheManager's HashMap
 *   - A DoubleLinkedList (warm or rendered)
 *
 * Carries prev/next directly (intrusive list pattern) so DoubleLinkedList
 * never allocates wrapper nodes.
 *
 * Always created at "warm" tier. Promotion to "rendered" requires an explicit
 * CacheManager.promote() call — never happens automatically.
 *
 * @typeParam T - The cached payload type. Opaque to the cache: no method here
 *                or in CacheManager ever inspects it.
 */
export class CacheEntry<T> {
  /** Unique cache key. Naming convention owned by the domain layer. */
  readonly key: string;

  /** Cached payload. Opaque to CacheManager; may be updated in place. */
  value: T;

  /** Caller-estimated memory footprint used for budget accounting. */
  sizeBytes: number;

  /**
   * "warm"     — in JS memory, not rendered. Lives in warmList. Eviction candidate.
   * "rendered" — active in the renderer. Lives in renderedList. Protected from eviction.
   */
  tier: CacheTier = "warm";

  /** More-recently-used neighbour. Managed by DoubleLinkedList. */
  prev: CacheEntry<T> | null = null;

  /** Less-recently-used neighbour. Managed by DoubleLinkedList. */
  next: CacheEntry<T> | null = null;

  constructor(key: string, value: T, sizeBytes: number) {
    // `key` is readonly: reassigning it would desync CacheManager's HashMap.
    this.key = key;
    this.value = value;
    this.sizeBytes = sizeBytes;
  }
}
