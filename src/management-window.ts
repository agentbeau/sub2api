import type { OAuthLeaseStorage } from "./oauth-lease.ts";

const STORAGE_KEY = "sub2api:management-window:v1";
const WINDOW_MS = 120_000;

// An explicit user action grants this hold. Reads and management polling never
// renew it; provider sign-ins and actual work have their own independent holds.
export class ManagementWindow {
  private until = 0;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: OAuthLeaseStorage, private readonly nowMs = Date.now) {}

  restore(): Promise<void> {
    return this.serialize(async () => {
      const saved = await this.storage.get<unknown>(STORAGE_KEY);
      const now = this.nowMs();
      this.until = typeof saved === "number" && Number.isSafeInteger(saved) && saved > now && saved <= now + WINDOW_MS ? saved : 0;
      if (this.until === 0) await this.storage.delete(STORAGE_KEY);
    });
  }

  remainingMs(): number {
    return Math.max(0, this.until - this.nowMs());
  }

  open(): Promise<void> {
    return this.serialize(async () => {
      this.until = this.nowMs() + WINDOW_MS;
      await this.storage.put(STORAGE_KEY, this.until);
    });
  }

  clear(): Promise<void> {
    return this.serialize(async () => {
      this.until = 0;
      await this.storage.delete(STORAGE_KEY);
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => {});
    return result;
  }
}
