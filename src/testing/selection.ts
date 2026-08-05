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
  // Pre-compute a parent-suite -> descendant-leaves index once so each
  // include/exclude suite resolves in O(1) instead of re-walking every leaf
  // for every suite (O(suites × leaves × depth)).
  const leavesBySuite = buildLeavesBySuiteIndex(leaves, byId);
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
        const descendantLeaves = leavesBySuite.get(id);
        if (descendantLeaves !== undefined) {
          for (const leafId of descendantLeaves) {
            selected.add(leafId);
          }
        }
      }
    }
  }

  for (const id of excludeIds) {
    const item = byId.get(id);
    if (item?.kind === "test") {
      selected.delete(item.id);
    } else if (item?.kind === "suite") {
      const descendantLeaves = leavesBySuite.get(id);
      if (descendantLeaves !== undefined) {
        for (const leafId of descendantLeaves) {
          selected.delete(leafId);
        }
      }
    }
  }

  return leaves.filter((leaf) => selected.has(leaf.id));
}

function buildLeavesBySuiteIndex(
  leaves: readonly TestDiscoveryTest[],
  byId: ReadonlyMap<string, TestDiscoveryModel["items"][number]>,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const leaf of leaves) {
    let parentId: string | null = leaf.parentId;
    const visited = new Set<string>();
    while (parentId !== null && !visited.has(parentId)) {
      let bucket = index.get(parentId);
      if (bucket === undefined) {
        bucket = new Set<string>();
        index.set(parentId, bucket);
      }
      bucket.add(leaf.id);
      visited.add(parentId);
      const parent = byId.get(parentId);
      parentId = parent?.kind === "suite" ? parent.parentId : null;
    }
  }
  return index;
}
