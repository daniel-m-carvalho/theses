/**
 * The contract an entry must satisfy to live in a {@link DoubleLinkedList}: it
 * carries its own links. Satisfied by {@link CacheEntry}.
 */
export interface Linkable<T> {
  prev: T | null;
  next: T | null;
}

/**
 * Intrusive double linked list.
 *
 * Entries must expose `prev` and `next` properties (see CacheEntry).
 * The list owns no memory beyond the head/tail pointers and a size counter.
 *
 * @typeParam T - The entry type, which must carry its own prev/next links.
 */
export class DoubleLinkedList<T extends Linkable<T>> {
  /** Most recently used entry, or null if the list is empty. */
  head: T | null = null;

  /**
   * Least recently used entry, or null if the list is empty.
   * Eviction always targets this end of the list.
   */
  tail: T | null = null;

  /** Number of entries currently in the list. Kept in sync by every mutation. */
  size = 0;

  /**
   * Inserts an entry at the front of the list (marks it most recently used).
   * The entry must not already be in any list.
   */
  pushFront(entry: T): void {
    entry.prev = null;
    entry.next = this.head;
    if (this.head) this.head.prev = entry;
    this.head = entry;
    if (!this.tail) this.tail = entry;
    this.size++;
  }

  /**
   * Removes an arbitrary entry from the list in O(1) using its own prev/next
   * pointers. The entry does not need to be at the head or tail.
   *
   * @param entry - Must currently be in this list.
   */
  remove(entry: T): void {
    if (entry.prev) entry.prev.next = entry.next;
    else this.head = entry.next;

    if (entry.next) entry.next.prev = entry.prev;
    else this.tail = entry.prev;

    entry.prev = null;
    entry.next = null;
    this.size--;
  }

  /**
   * Moves an existing entry to the front of the list, marking it as the most
   * recently used. Used by CacheManager on every cache hit and on promote/demote.
   *
   * @param entry - Must currently be in this list.
   */
  moveToFront(entry: T): void {
    this.remove(entry);
    this.pushFront(entry);
  }

  /**
   * Removes and returns the tail entry (least recently used), or null if the
   * list is empty. Used by CacheManager's eviction loop to find the next
   * eviction candidate.
   */
  popTail(): T | null {
    if (!this.tail) return null;
    const entry = this.tail;
    this.remove(entry);
    return entry;
  }
}
