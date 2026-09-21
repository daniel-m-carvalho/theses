// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { SelectionOperator } from "./selection";
import { makeHarness, namedTree } from "./harness";

describe("SelectionOperator", () => {
  it("starts with nothing selected", () => {
    const h = makeHarness(namedTree());
    const sel = new SelectionOperator();
    sel.attach(h.viewer);
    expect(sel.getSelected().size).toBe(0);
  });

  it("selects a node on click", () => {
    const h = makeHarness(namedTree());
    const sel = new SelectionOperator();
    sel.attach(h.viewer);
    h.render();

    h.viewer.events.emit("clickNode", { node: "named_a" });
    expect(sel.getSelected().has("named_a")).toBe(true);
  });

  it("replaces the selection on each click (click is single-select)", () => {
    // Multi-select is the drag-box path, not accumulated clicking.
    const h = makeHarness(namedTree());
    const sel = new SelectionOperator();
    sel.attach(h.viewer);
    h.render();

    h.viewer.events.emit("clickNode", { node: "named_a" });
    h.viewer.events.emit("clickNode", { node: "named_c" });

    expect([...sel.getSelected()]).toEqual(["named_c"]);
  });

  it("ignores clicks on invisible connector nodes", () => {
    const h = makeHarness(namedTree());
    const sel = new SelectionOperator();
    sel.attach(h.viewer);
    h.render();

    h.viewer.events.emit("clickNode", { node: "named_a" });
    h.viewer.events.emit("clickNode", { node: "v_0" }); // a layout helper
    expect([...sel.getSelected()]).toEqual(["named_a"]);
  });

  it("clears the selection on a stage click", () => {
    const h = makeHarness(namedTree());
    const sel = new SelectionOperator();
    sel.attach(h.viewer);
    h.render();

    h.viewer.events.emit("clickNode", { node: "named_a" });
    h.viewer.events.emit("clickStage", { x: 0, y: 0 });
    expect(sel.getSelected().size).toBe(0);
  });

  it("clearSelection empties it programmatically", () => {
    const h = makeHarness(namedTree());
    const sel = new SelectionOperator();
    sel.attach(h.viewer);
    h.render();

    h.viewer.events.emit("clickNode", { node: "named_a" });
    sel.clearSelection();
    expect(sel.getSelected().size).toBe(0);
  });

  it("notifies on every change", () => {
    const h = makeHarness(namedTree());
    const sel = new SelectionOperator();
    const onChange = vi.fn();
    sel.attach(h.viewer);
    sel.setOnChange(onChange);
    h.render();

    h.viewer.events.emit("clickNode", { node: "named_a" });
    expect(onChange).toHaveBeenCalledWith(["named_a"]);

    sel.clearSelection();
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("toggles drag-select mode", () => {
    const sel = new SelectionOperator();
    expect(sel.isDragSelectEnabled()).toBe(false); // default per README §9.3

    sel.setDragSelectEnabled(true);
    expect(sel.isDragSelectEnabled()).toBe(true);
  });

  it("honours the dragSelectEnabled option", () => {
    expect(new SelectionOperator({ dragSelectEnabled: true }).isDragSelectEnabled()).toBe(true);
  });

  it("styles selected nodes through the reducer pipeline", () => {
    const h = makeHarness(namedTree());
    new SelectionOperator().attach(h.viewer);
    h.render();

    const before = h.styleOf("named_a");
    h.viewer.events.emit("clickNode", { node: "named_a" });
    const after = h.styleOf("named_a");

    expect(after).not.toEqual(before); // highlight contributed by its reducer
  });

  it("stops styling after detach", () => {
    const h = makeHarness(namedTree());
    const sel = new SelectionOperator();
    sel.attach(h.viewer);
    h.render();
    h.viewer.events.emit("clickNode", { node: "named_a" });

    const selected = h.styleOf("named_a");
    sel.detach();
    expect(h.styleOf("named_a")).not.toEqual(selected);
  });
});
