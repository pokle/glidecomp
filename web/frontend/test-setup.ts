import { beforeAll, beforeEach } from "vitest";

// Node 22+ ships an experimental web-storage shim that's installed onto
// globalThis as an empty `{}` (no clear/setItem/getItem methods). It also
// shadows whatever jsdom would otherwise provide. We bypass both with a
// minimal in-memory Storage implementation that satisfies the spec surface
// our code uses.

function createMemStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      store = {};
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key)
        ? store[key]
        : null;
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
    removeItem(key: string) {
      delete store[key];
    },
    setItem(key: string, value: string) {
      store[key] = String(value);
    },
  } as Storage;
}

beforeAll(() => {
  const localShim = createMemStorage();
  const sessionShim = createMemStorage();
  for (const target of [globalThis, window]) {
    Object.defineProperty(target, "localStorage", {
      value: localShim,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(target, "sessionStorage", {
      value: sessionShim,
      writable: true,
      configurable: true,
    });
  }
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
