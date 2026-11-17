// Durable Object storage is the only persistence boundary replaced in lease tests.
export class LeaseStorage {
  private readonly values = new Map<string, unknown>();
  private queue = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async transaction<T>(callback: (txn: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  }) => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await callback({
        get: <V>(key: string) => this.get<V>(key),
        put: <V>(key: string, value: V) => this.put(key, value),
        delete: (key: string) => this.delete(key),
      });
    } finally {
      release();
    }
  }
}
