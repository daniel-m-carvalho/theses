import { beforeEach, describe, expect, it } from "vitest";

import { clearDraft, EMPTY_FIELDS, loadFields, loadFiles, saveFields } from "./draft";

/** jsdom here has no localStorage (the test page has an opaque origin). */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

describe("upload draft", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  });

  it("brings the typed values back after a refresh", () => {
    const typed = {
      name: "Aureus against Staph",
      leftSpecies: "Aureus-rapidNJ",
      rightSpecies: "Staphylococcus-NJ",
      sharedTyping: false,
      metric: "triplet",
    };
    saveFields(typed);
    expect(loadFields()).toEqual(typed);
  });

  it("starts empty when nothing was saved", () => {
    expect(loadFields()).toEqual(EMPTY_FIELDS);
  });

  it("ignores a stored value of the wrong shape rather than rendering it", () => {
    window.localStorage.setItem(
      "phylodelta.uploadDraft.v1",
      JSON.stringify({ name: 42, sharedTyping: "yes", leftSpecies: "kept" }),
    );
    expect(loadFields()).toEqual({ ...EMPTY_FIELDS, leftSpecies: "kept" });
  });

  it("survives storage that is not JSON", () => {
    window.localStorage.setItem("phylodelta.uploadDraft.v1", "{not json");
    expect(loadFields()).toEqual(EMPTY_FIELDS);
  });

  it("is cleared once the upload has gone through", async () => {
    saveFields({ ...EMPTY_FIELDS, name: "done" });
    await clearDraft();
    expect(loadFields()).toEqual(EMPTY_FIELDS);
  });

  it("does not fail the form where storage is missing altogether", () => {
    Object.defineProperty(window, "localStorage", { value: undefined, configurable: true });
    expect(loadFields()).toEqual(EMPTY_FIELDS);
    expect(() => saveFields(EMPTY_FIELDS)).not.toThrow();
  });

  it("remembers no files, and does not fail, where IndexedDB is missing", async () => {
    // jsdom has none — the same position as a browser with storage blocked.
    await expect(loadFiles()).resolves.toEqual({});
  });
});
