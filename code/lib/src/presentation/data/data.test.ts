import { describe, expect, it } from "vitest";
import type { NewickNode } from "../tree/types";
import { datumSegments, datumTotal } from "./leaf_data";
import { keyByClade, keyByName } from "./comparison";

describe("datumTotal", () => {
  it("uses an explicit total", () => {
    expect(datumTotal({ total: 12 })).toBe(12);
  });

  it("sums segments when no total is given", () => {
    expect(
      datumTotal({ segments: [{ key: "PT", value: 3 }, { key: "ES", value: 4 }] })
    ).toBe(7);
  });

  it("prefers an explicit total over the segment sum", () => {
    expect(
      datumTotal({ total: 100, segments: [{ key: "PT", value: 3 }] })
    ).toBe(100);
  });

  it("floors negative magnitudes at zero", () => {
    expect(datumTotal({ total: -5 })).toBe(0);
    expect(datumTotal({ segments: [{ key: "x", value: -5 }] })).toBe(0);
  });

  it("treats an empty datum as zero", () => {
    expect(datumTotal({})).toBe(0);
  });
});

describe("datumSegments", () => {
  it("returns the composition when present", () => {
    const segs = datumSegments(
      { segments: [{ key: "PT", value: 3 }, { key: "ES", value: 1 }] },
      "ST1"
    );
    expect(segs.map((s) => s.key)).toEqual(["PT", "ES"]);
  });

  it("turns a single value into one segment keyed by the identifier", () => {
    // So a plain count still gets a semantic color from the shared scale.
    expect(datumSegments({ total: 9 }, "ST1")).toEqual([{ key: "ST1", value: 9 }]);
  });

  it("drops zero and negative segments", () => {
    const segs = datumSegments(
      {
        segments: [
          { key: "PT", value: 3 },
          { key: "ES", value: 0 },
          { key: "FR", value: -2 },
        ],
      },
      "ST1"
    );
    expect(segs.map((s) => s.key)).toEqual(["PT"]);
  });

  it("always returns at least one segment", () => {
    expect(datumSegments({}, "ST1")).toHaveLength(1);
  });

  it("preserves an explicit per-segment color override", () => {
    const segs = datumSegments(
      { segments: [{ key: "PT", value: 1, color: "#ff0000" }] },
      "ST1"
    );
    expect(segs[0].color).toBe("#ff0000");
  });
});

describe("node keyers", () => {
  const clade = (): NewickNode => ({
    name: "",
    branchset: [{ name: "b" }, { name: "a" }],
  });

  it("keyByClade is order-independent (canonical leaf set)", () => {
    const left = clade();
    const right: NewickNode = { name: "", branchset: [{ name: "a" }, { name: "b" }] };
    expect(keyByClade(left)).toBe(keyByClade(right));
    expect(keyByClade(left)).toBe("a|b");
  });

  it("keyByClade works for unnamed internal nodes", () => {
    expect(keyByClade(clade())).not.toBe("");
  });

  it("keyByClade of a leaf is its own name", () => {
    expect(keyByClade({ name: "solo" })).toBe("solo");
  });

  it("keyByClade distinguishes different leaf sets", () => {
    const other: NewickNode = { name: "", branchset: [{ name: "a" }, { name: "c" }] };
    expect(keyByClade(clade())).not.toBe(keyByClade(other));
  });

  it("keyByName uses the node's own name, empty when unnamed", () => {
    expect(keyByName({ name: "ST12" })).toBe("ST12");
    expect(keyByName(clade())).toBe("");
  });
});
