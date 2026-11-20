/**
 * Browser storage keys are `aimpoint:<name>` since VEC-321; before that they were `vector:<name>`. `adoptLegacyKey`
 * moves a value left under the old key to the new one (once: the old key is removed), so people keep their saved
 * board views, folded groups and a dismissed install prompt. Call it before the first read of a key. Never throws
 * (storage can be blocked or full). Pure, so it's unit tested with a fake Storage (stored-keys.test.mjs).
 */

export const STORAGE_PREFIX = "aimpoint:";
export const LEGACY_STORAGE_PREFIX = "vector:";

type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `aimpoint:<name>`. */
export const storageKey = (name: string) => `${STORAGE_PREFIX}${name}`;

/** Moves `vector:<name>` to `aimpoint:<name>` unless the new key already holds a value; drops the old key either way. */
export function adoptLegacyKey(store: KeyValueStore, key: string): void {
  if (!key.startsWith(STORAGE_PREFIX)) return;
  const legacy = LEGACY_STORAGE_PREFIX + key.slice(STORAGE_PREFIX.length);
  try {
    const old = store.getItem(legacy);
    if (old === null) return;
    if (store.getItem(key) === null) store.setItem(key, old);
    store.removeItem(legacy);
  } catch {}
}
