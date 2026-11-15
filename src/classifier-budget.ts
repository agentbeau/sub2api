// Persisted per enhanced singleton. Reservations include failed/timed-out calls.
interface Ledger { day: number; daily: number; minute: number; burst: number }
interface Store {
  transaction<T>(callback: (txn: {get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>})=>Promise<T>):Promise<T>;
}
export async function reserveClassification(store: Store, now = Date.now()): Promise<boolean> {
  return store.transaction(async txn => {
    const key = "clef-budget-v1";
    const day = Math.floor(now / 86_400_000), minute = Math.floor(now / 60_000);
    const old = await txn.get<Ledger>(key);
    if (old && ![old.day, old.daily, old.minute, old.burst].every(n => Number.isSafeInteger(n) && n >= 0)) return false;
    // Clock rollback fails closed rather than reusing an earlier budget.
    if (old && (old.day > day || old.minute > minute)) return false;
    const daily = old?.day === day ? old.daily : 0;
    const burst = old?.minute === minute ? old.burst : 0;
    if (daily >= 100 || burst >= 10) return false;
    await txn.put(key, {day, minute, daily:daily+1, burst:burst+1});
    return true;
  });
}
