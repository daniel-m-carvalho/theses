import { describe, expect, it } from "vitest";

import type { DatasetsResponse, PairSummary } from "./api/types";
import { pairName, treeName } from "./names";

const datasets = {
  trees: [
    { id: "0603c72037c7", display_name: "aureus-rapidnj-tree" },
    { id: "1531dacf584f", display_name: "" },
  ],
  pairs: [],
  isolates: [],
} as unknown as DatasetsResponse;

const pair = (display_name: string) =>
  ({ id: "0603c72037c7__1531dacf584f", left: "0603c72037c7", right: "1531dacf584f", display_name }) as PairSummary;

describe("names", () => {
  it("shows a tree's name, not its id", () => {
    expect(treeName("0603c72037c7", datasets)).toBe("aureus-rapidnj-tree");
  });

  it("falls back to the id only when nothing was named", () => {
    expect(treeName("1531dacf584f", datasets)).toBe("1531dacf584f");
    expect(treeName("unknown", null)).toBe("unknown");
  });

  it("shows the name given to the comparison", () => {
    expect(pairName(pair("Aureus against Staph"), datasets)).toBe("Aureus against Staph");
  });

  it("builds one from the tree names when the comparison has none", () => {
    expect(pairName(pair(""), datasets)).toBe("aureus-rapidnj-tree vs 1531dacf584f");
  });
});
