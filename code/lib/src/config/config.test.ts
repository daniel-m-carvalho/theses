// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sigma needs a GPU context, so the bootstrap is tested against a stub. What
 * matters here is the *wiring* the config layer performs — which operators get
 * attached, how options are translated, how panels are linked — none of which
 * involves rendering.
 */
vi.mock("sigma", async () => await import("../test_support/fake_sigma"));

const { createComparison, createFromConfig, createViewer } = await import("./config");
const { binaryTree, namedTree } = await import("../presentation/operators/harness");

let containers: HTMLElement[];

beforeEach(() => {
  document.body.innerHTML = "";
  containers = [0, 1].map(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    return el;
  });
});

describe("createViewer", () => {
  it("attaches the default operator set", () => {
    const { operators } = createViewer(containers[0], {}, { tree: namedTree() });

    expect(operators.expandCollapse).toBeDefined();
    expect(operators.selection).toBeDefined();
    expect(operators.cladeShape).toBeDefined();
  });

  it("attaches bar charts only when the config names them", () => {
    // Inconsistent with the three operators above, which default to on: the
    // barcharts branch is `if (ops.barcharts)`, so an absent key means absent
    // operator (not merely hidden). Documented here because it is load-bearing
    // for any app that omits the key and then reads handle.operators.barcharts.
    const bare = createViewer(containers[0], {}, { tree: namedTree() });
    expect(bare.operators.barcharts).toBeUndefined();

    const named = createViewer(
      containers[1],
      { operators: { barcharts: {} } },
      { tree: namedTree() }
    );
    expect(named.operators.barcharts).toBeDefined();
  });

  it("omits operators that are disabled", () => {
    const { operators } = createViewer(
      containers[0],
      {
        operators: {
          expandCollapse: false,
          selection: { enabled: false },
          cladeShape: false,
        },
      },
      { tree: namedTree() }
    );

    expect(operators.expandCollapse).toBeUndefined();
    expect(operators.selection).toBeUndefined();
    expect(operators.cladeShape).toBeUndefined();
  });

  it("feeds the tree in so operators bind on first render", () => {
    const tree = namedTree();
    const { viewer } = createViewer(containers[0], {}, { tree });
    expect(viewer.getTree()).toBe(tree);
  });

  it("passes viewer options through", () => {
    const { viewer } = createViewer(
      containers[0],
      { viewer: { layoutMode: "phylogram", reflect: true } },
      { tree: namedTree() }
    );

    expect(viewer.getLayoutMode()).toBe("phylogram");
    expect(viewer.isReflected()).toBe(true);
  });

  it("translates expandCollapse depth options", () => {
    const { operators } = createViewer(
      containers[0],
      { operators: { expandCollapse: { depth: 3 } } },
      { tree: binaryTree(5) }
    );

    expect(operators.expandCollapse!.getInitialDepth()).toBe(3);
    expect(operators.expandCollapse!.getExpandDepth()).toBe(3);
  });

  it("lets initialDepth and expandDepth override the shared depth", () => {
    const { operators } = createViewer(
      containers[0],
      { operators: { expandCollapse: { depth: 3, expandDepth: 1 } } },
      { tree: binaryTree(5) }
    );

    expect(operators.expandCollapse!.getInitialDepth()).toBe(3);
    expect(operators.expandCollapse!.getExpandDepth()).toBe(1);
  });

  it("applies the opening depth to the tree", () => {
    const { operators } = createViewer(
      containers[0],
      { operators: { expandCollapse: { depth: 2 } } },
      { tree: binaryTree(5) }
    );

    expect(operators.expandCollapse!.getDepth()).toBe(2);
    expect(operators.expandCollapse!.getCollapsed().size).toBeGreaterThan(0);
  });

  it("starts bar charts and comparison per their enabled flags", () => {
    const { operators } = createViewer(
      containers[0],
      // `comparison` is top-level, never inside `operators` — one comparison,
      // one config, whatever the panel count.
      { operators: { barcharts: { enabled: false } }, comparison: { enabled: true } },
      { tree: namedTree() }
    );

    expect(operators.barcharts!.isEnabled()).toBe(false);
    expect(operators.comparison!.isEnabled()).toBe(true);
  });

  it("honours the comparison mode from config", () => {
    const { operators } = createViewer(
      containers[0],
      { comparison: { mode: "membership" } },
      { tree: namedTree() }
    );

    expect(operators.comparison!.getMode()).toBe("membership");
  });

  it("destroy tears everything down without throwing", () => {
    const handle = createViewer(containers[0], {}, { tree: namedTree() });
    expect(() => handle.destroy()).not.toThrow();
  });
});

describe("createComparison", () => {
  const twoPanels = {
    panels: [
      { id: "left", viewer: { reflect: false } },
      { id: "right", viewer: { reflect: true } },
    ],
  };

  it("builds one panel per config entry", () => {
    const handle = createComparison(containers, twoPanels, {
      trees: [namedTree(), namedTree()],
    });

    expect(handle.panels).toHaveLength(2);
    expect(handle.panels[0].viewer.isReflected()).toBe(false);
    expect(handle.panels[1].viewer.isReflected()).toBe(true);
  });

  it("gives each panel its own index-aligned tree", () => {
    const a = namedTree();
    const b = binaryTree(3);
    const handle = createComparison(containers, twoPanels, { trees: [a, b] });

    expect(handle.panels[0].viewer.getTree()).toBe(a);
    expect(handle.panels[1].viewer.getTree()).toBe(b);
  });

  it("throws when there are fewer containers than panels", () => {
    expect(() =>
      createComparison([containers[0]], twoPanels, { trees: [namedTree(), namedTree()] })
    ).toThrow(/panels/);
  });

  it("applies the one top-level comparison config to every panel", () => {
    // The point of hoisting it out of `operators`: both panels are guaranteed
    // the same mode/keying, so they cannot disagree about the comparison they
    // are jointly presenting.
    const handle = createComparison(
      containers,
      { ...twoPanels, comparison: { enabled: true, mode: "membership" } },
      { trees: [namedTree(), namedTree()] }
    );

    for (const panel of handle.panels) {
      expect(panel.operators.comparison).toBeDefined();
      expect(panel.operators.comparison!.getMode()).toBe("membership");
      expect(panel.operators.comparison!.isEnabled()).toBe(true);
    }
  });

  it("attaches no comparison operator when the block is omitted", () => {
    const handle = createComparison(containers, twoPanels, {
      trees: [namedTree(), namedTree()],
    });

    expect(handle.panels[0].operators.comparison).toBeUndefined();
    expect(handle.panels[1].operators.comparison).toBeUndefined();
  });

  it("shares one categorical color scale across panels", () => {
    // So a category is the same color in both trees (README §10).
    const withBars = {
      panels: [
        { id: "left", operators: { barcharts: {} } },
        { id: "right", operators: { barcharts: {} } },
      ],
    };
    const handle = createComparison(containers, withBars, {
      trees: [namedTree(), namedTree()],
    });

    expect(handle.panels[0].operators.barcharts!.getColorScale()).toBe(
      handle.panels[1].operators.barcharts!.getColorScale()
    );
  });

  it("destroy tears down every panel", () => {
    const handle = createComparison(containers, twoPanels, {
      trees: [namedTree(), namedTree()],
    });
    expect(() => handle.destroy()).not.toThrow();
  });
});

describe("createFromConfig — dispatch", () => {
  it("builds a comparison when panels are present", () => {
    const handle = createFromConfig(
      containers,
      { panels: [{ id: "a" }, { id: "b" }] },
      { trees: [namedTree(), namedTree()] }
    );
    expect(handle.panels).toHaveLength(2);
  });

  it("builds a single panel from the viewer/operators form", () => {
    const handle = createFromConfig(
      containers,
      { viewer: { layoutMode: "phylogram" } },
      { trees: [namedTree()] }
    );

    expect(handle.panels).toHaveLength(1);
    expect(handle.panels[0].viewer.getLayoutMode()).toBe("phylogram");
  });
});
