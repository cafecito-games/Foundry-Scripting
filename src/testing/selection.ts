import type {
  TestDiscoveryModel,
  TestDiscoveryTest,
} from "./discovery.js";

export function selectRunnableLeaves(
  model: TestDiscoveryModel,
  includeIds: readonly string[] | undefined,
  excludeIds: readonly string[],
): readonly TestDiscoveryTest[] {
  const byId = new Map(model.items.map((item) => [item.id, item] as const));
  const leaves = model.items.filter(
    (item): item is TestDiscoveryTest => item.kind === "test" && item.runnable,
  );
  const selected = new Set<string>();

  if (includeIds === undefined) {
    for (const leaf of leaves) {
      selected.add(leaf.id);
    }
  } else {
    for (const id of includeIds) {
      const item = byId.get(id);
      if (item?.kind === "test" && item.runnable) {
        selected.add(item.id);
      } else if (item?.kind === "suite") {
        addDescendantLeaves(item.id, leaves, byId, selected);
      }
    }
  }

  for (const id of excludeIds) {
    const item = byId.get(id);
    if (item?.kind === "test") {
      selected.delete(item.id);
    } else if (item?.kind === "suite") {
      removeDescendantLeaves(item.id, leaves, byId, selected);
    }
  }

  return leaves.filter((leaf) => selected.has(leaf.id));
}

function addDescendantLeaves(
  suiteId: string,
  leaves: readonly TestDiscoveryTest[],
  byId: ReadonlyMap<string, TestDiscoveryModel["items"][number]>,
  selected: Set<string>,
): void {
  for (const leaf of leaves) {
    if (hasAncestor(leaf, suiteId, byId)) {
      selected.add(leaf.id);
    }
  }
}

function removeDescendantLeaves(
  suiteId: string,
  leaves: readonly TestDiscoveryTest[],
  byId: ReadonlyMap<string, TestDiscoveryModel["items"][number]>,
  selected: Set<string>,
): void {
  for (const leaf of leaves) {
    if (hasAncestor(leaf, suiteId, byId)) {
      selected.delete(leaf.id);
    }
  }
}

function hasAncestor(
  leaf: TestDiscoveryTest,
  suiteId: string,
  byId: ReadonlyMap<string, TestDiscoveryModel["items"][number]>,
): boolean {
  let parentId: string | null = leaf.parentId;
  const visited = new Set<string>();
  while (parentId !== null && !visited.has(parentId)) {
    if (parentId === suiteId) {
      return true;
    }
    visited.add(parentId);
    const parent = byId.get(parentId);
    parentId = parent?.kind === "suite" ? parent.parentId : null;
  }
  return false;
}
