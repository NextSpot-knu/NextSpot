// 웹 코드가 쓰는 sessionStorage 의 앱 대역 — 앱 실행 동안만 산다(§5.2).
// localStorage 는 expo-sqlite 가 전역으로 깐다(index.ts).
class MemoryStorage {
  private items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.items.has(key) ? (this.items.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  clear(): void {
    this.items.clear();
  }
}

const target = globalThis as unknown as { sessionStorage?: unknown };
if (!target.sessionStorage) target.sessionStorage = new MemoryStorage();
