/** Minimal typed event emitter shared by the viewer and its operators. */
export type Handler<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private handlers: { [K in keyof Events]?: Set<Handler<Events[K]>> } = {};

  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    (this.handlers[type] ??= new Set()).add(handler);
    return () => this.off(type, handler);
  }

  off<K extends keyof Events>(type: K, handler: Handler<Events[K]>): void {
    this.handlers[type]?.delete(handler);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.handlers[type]?.forEach((h) => h(payload));
  }

  clear(): void {
    this.handlers = {};
  }
}
