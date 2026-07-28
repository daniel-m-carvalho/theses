import { describe, expect, it } from "vitest";
import { parseNewick } from "./newick";
import { countLeaves, maxDepth } from "./model";

describe("parseNewick", () => {
  it("parses a simple tree with names and branch lengths", () => {
    const tree = parseNewick("(a:1,b:2)root;");
    expect(tree.name).toBe("root");
    expect(countLeaves(tree)).toBe(2);
    expect(tree.branchset!.map((n) => n.name).sort()).toEqual(["a", "b"]);
    expect(tree.branchset!.find((n) => n.name === "b")!.length).toBe(2);
  });

  it("parses nested clades", () => {
    const tree = parseNewick("((a,b),(c,d));");
    expect(countLeaves(tree)).toBe(4);
    expect(maxDepth(tree)).toBe(2);
  });

  it("tolerates unnamed internal nodes (the NJ/UPGMA shape)", () => {
    const tree = parseNewick("((a:1,b:1):2,c:3);");
    expect(countLeaves(tree)).toBe(3);
    const internal = tree.branchset!.find((n) => n.branchset?.length)!;
    expect(internal.branchset).toHaveLength(2);
  });

  it("returns the largest component of a forest", () => {
    // goeBURST output is a forest: one real tree plus many singleton STs.
    const tree = parseNewick("(a,b,c,d);(x,y);z;");
    expect(countLeaves(tree)).toBe(4);
  });

  it("skips singleton components with no clade", () => {
    const tree = parseNewick("101;102;(a,b);103;");
    expect(countLeaves(tree)).toBe(2);
  });

  it("ignores unparseable fragments rather than throwing", () => {
    const tree = parseNewick("(((broken;(a,b,c);");
    expect(countLeaves(tree)).toBe(3);
  });

  it("parses a single-leaf clade", () => {
    const tree = parseNewick("(a);");
    expect(countLeaves(tree)).toBe(1);
    expect(tree.branchset![0].name).toBe("a");
  });

  it("throws rather than returning a degenerate tree", () => {
    // The underlying parser returns `{}` for all of these — truthy, and cast to
    // NewickNode despite lacking a name. Rendering it would show a single blank
    // tip, making a failed backend response look like a real one-node tree.
    // Note a bare `"a;"` is in this group: the parser only handles parenthesized
    // trees, which is consistent with singleton components being skipped above.
    for (const input of ["", "   ", ";;;", "garbage", "a;"]) {
      expect(() => parseNewick(input), `input: ${JSON.stringify(input)}`).toThrow(
        /No tree found/
      );
    }
  });
});
