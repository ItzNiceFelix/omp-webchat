/** React binding for the store singleton. */
import { useSyncExternalStore } from "react";
import { store, type Store } from "./store";

export { store };
export type { Store };

/**
 * Subscribe to one slice of the store.
 *
 * The selector MUST return a value stored on the store (a slice or a primitive) or a derived
 * primitive — never a fresh object or array, which would make every render look like a change.
 * Derive inside the component instead: `const messages = useStore((s) => s.messages)`.
 */
export function useStore<T>(select: (store: Store) => T): T {
	return useSyncExternalStore(store.subscribe, () => select(store), () => select(store));
}
