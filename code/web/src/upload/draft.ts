/**
 * The upload form, kept across a refresh.
 *
 * A half-filled form is a draft belonging to whoever is filling it in, so it
 * lives in this browser — not in the URL, which names what is being *looked
 * at* and is meant to be sent to someone (useUrlState.ts). Cleared once the
 * upload succeeds: a finished comparison is in the list, and a form that came
 * back pre-filled with it would invite uploading it twice.
 *
 * Two stores, because they hold different things:
 *
 * * the typed values, in localStorage — small strings, read synchronously so
 *   the form renders filled rather than flashing empty;
 * * the dropped files, in IndexedDB — a tree is up to ~25 MB and a `File`
 *   cannot be put in localStorage at all, while IndexedDB stores it as is.
 *
 * Every access is guarded. Storage can be absent or refuse (a private window,
 * blocked site data, a full quota), and then the form simply does not
 * remember — it must never fail to work because it could not save.
 */

export type Slot = "left_tree" | "right_tree" | "left_isolates" | "right_isolates";

export interface DraftFields {
  name: string;
  leftSpecies: string;
  rightSpecies: string;
  sharedTyping: boolean;
  /** Empty until chosen; restored only if the server still offers it. */
  metric: string;
}

export const EMPTY_FIELDS: DraftFields = {
  name: "",
  leftSpecies: "",
  rightSpecies: "",
  sharedTyping: true,
  metric: "",
};

const FIELDS_KEY = "phylodelta.uploadDraft.v1";

export function loadFields(): DraftFields {
  try {
    const raw = window.localStorage.getItem(FIELDS_KEY);
    if (!raw) return EMPTY_FIELDS;
    const parsed = JSON.parse(raw) as Partial<DraftFields>;
    // Field by field and typed, so a value written by an older version, or
    // edited by hand, cannot put a non-string into a controlled input.
    return {
      name: typeof parsed.name === "string" ? parsed.name : "",
      leftSpecies: typeof parsed.leftSpecies === "string" ? parsed.leftSpecies : "",
      rightSpecies: typeof parsed.rightSpecies === "string" ? parsed.rightSpecies : "",
      sharedTyping: typeof parsed.sharedTyping === "boolean" ? parsed.sharedTyping : true,
      metric: typeof parsed.metric === "string" ? parsed.metric : "",
    };
  } catch {
    return EMPTY_FIELDS;
  }
}

export function saveFields(fields: DraftFields): void {
  try {
    window.localStorage.setItem(FIELDS_KEY, JSON.stringify(fields));
  } catch {
    // Not remembering is acceptable; failing the form is not.
  }
}

// --- files -----------------------------------------------------------------

const DB_NAME = "phylodelta";
const STORE = "uploadDraft";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  act: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE, mode);
      const request = act(transaction.objectStore(STORE));
      transaction.oncomplete = () => {
        db.close();
        resolve(request ? request.result : undefined);
      };
      transaction.onerror = transaction.onabort = () => {
        db.close();
        resolve(undefined);
      };
    } catch {
      db.close();
      resolve(undefined);
    }
  });
}

export async function loadFiles(): Promise<Partial<Record<Slot, File>>> {
  const out: Partial<Record<Slot, File>> = {};
  for (const slot of ["left_tree", "right_tree", "left_isolates", "right_isolates"] as Slot[]) {
    const file = await withStore<unknown>("readonly", (store) => store.get(slot));
    if (file instanceof File) out[slot] = file;
  }
  return out;
}

export function saveFile(slot: Slot, file: File | undefined): Promise<unknown> {
  return withStore<unknown>("readwrite", (store) => {
    if (file) store.put(file, slot);
    else store.delete(slot);
  });
}

export function clearDraft(): Promise<unknown> {
  try {
    window.localStorage.removeItem(FIELDS_KEY);
  } catch {
    // As above.
  }
  return withStore<unknown>("readwrite", (store) => {
    store.clear();
  });
}
