import { describe, expect, it } from "vitest";
import { DoubleLinkedList, type Linkable } from "./double_linked_list";

class Node implements Linkable<Node> {
  prev: Node | null = null;
  next: Node | null = null;
  constructor(readonly id: string) {}
}

/** Read the list head → tail, so link integrity is checked in both directions. */
function forward(list: DoubleLinkedList<Node>): string[] {
  const out: string[] = [];
  for (let n = list.head; n; n = n.next) out.push(n.id);
  return out;
}

function backward(list: DoubleLinkedList<Node>): string[] {
  const out: string[] = [];
  for (let n = list.tail; n; n = n.prev) out.push(n.id);
  return out;
}

function listOf(...ids: string[]) {
  const list = new DoubleLinkedList<Node>();
  const nodes = new Map<string, Node>();
  // pushFront reverses, so insert backwards to get `ids` in order.
  for (const id of [...ids].reverse()) {
    const n = new Node(id);
    nodes.set(id, n);
    list.pushFront(n);
  }
  return { list, nodes };
}

describe("DoubleLinkedList", () => {
  it("starts empty", () => {
    const list = new DoubleLinkedList<Node>();
    expect(list.head).toBeNull();
    expect(list.tail).toBeNull();
    expect(list.size).toBe(0);
    expect(list.popTail()).toBeNull();
  });

  it("pushFront makes the newest entry the head", () => {
    const { list } = listOf("a", "b", "c");
    expect(forward(list)).toEqual(["a", "b", "c"]);
    expect(list.head!.id).toBe("a");
    expect(list.tail!.id).toBe("c");
    expect(list.size).toBe(3);
  });

  it("keeps forward and backward traversal consistent", () => {
    const { list } = listOf("a", "b", "c");
    expect(backward(list)).toEqual([...forward(list)].reverse());
  });

  it("removes from the middle in O(1) without breaking links", () => {
    const { list, nodes } = listOf("a", "b", "c");
    list.remove(nodes.get("b")!);

    expect(forward(list)).toEqual(["a", "c"]);
    expect(backward(list)).toEqual(["c", "a"]);
    expect(list.size).toBe(2);
  });

  it("clears the removed entry's own links", () => {
    const { list, nodes } = listOf("a", "b", "c");
    const b = nodes.get("b")!;
    list.remove(b);
    expect(b.prev).toBeNull();
    expect(b.next).toBeNull();
  });

  it("removing the head and tail updates both pointers", () => {
    const { list, nodes } = listOf("a", "b", "c");
    list.remove(nodes.get("a")!);
    expect(list.head!.id).toBe("b");

    list.remove(nodes.get("c")!);
    expect(list.tail!.id).toBe("b");
    expect(forward(list)).toEqual(["b"]);
  });

  it("removing the only entry empties the list", () => {
    const { list, nodes } = listOf("solo");
    list.remove(nodes.get("solo")!);
    expect(list.head).toBeNull();
    expect(list.tail).toBeNull();
    expect(list.size).toBe(0);
  });

  it("moveToFront promotes without changing size", () => {
    const { list, nodes } = listOf("a", "b", "c");
    list.moveToFront(nodes.get("c")!);

    expect(forward(list)).toEqual(["c", "a", "b"]);
    expect(list.size).toBe(3);
    expect(list.tail!.id).toBe("b");
  });

  it("moveToFront on the head is a no-op in effect", () => {
    const { list, nodes } = listOf("a", "b");
    list.moveToFront(nodes.get("a")!);
    expect(forward(list)).toEqual(["a", "b"]);
  });

  it("popTail returns the LRU end and shrinks the list", () => {
    const { list } = listOf("a", "b", "c");
    expect(list.popTail()!.id).toBe("c");
    expect(list.popTail()!.id).toBe("b");
    expect(list.size).toBe(1);
    expect(list.popTail()!.id).toBe("a");
    expect(list.popTail()).toBeNull();
  });
});
