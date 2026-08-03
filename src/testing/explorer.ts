import path from "node:path";
import type * as vscode from "vscode";
import type {
  TestDiscoveryItem,
  TestDiscoveryModel,
  TestDiscoveryRange,
} from "./discovery.js";

export interface FoundryTestExplorerValues {
  readonly createUri: (nativePath: string) => vscode.Uri;
  readonly createRange: (range: TestDiscoveryRange) => vscode.Range;
}

export interface FoundryTestItemMetadata {
  readonly kind: TestDiscoveryItem["kind"];
  readonly parentId: string | null;
  readonly resourcePath: string | null;
  readonly runnable: boolean;
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly caseKey: string | null;
}

export interface FoundryTestExplorerSnapshot {
  readonly model: TestDiscoveryModel;
  readonly item: (id: string) => vscode.TestItem | undefined;
}

interface DesiredItem {
  readonly record: TestDiscoveryItem;
  readonly nativePath: string | null;
  readonly order: number;
}

export class FoundryTestExplorer {
  private readonly items = new Map<string, vscode.TestItem>();
  private readonly metadata = new Map<string, FoundryTestItemMetadata>();
  private readonly nativePaths = new Map<string, string | null>();
  private model: TestDiscoveryModel | undefined;

  constructor(
    private readonly controller: vscode.TestController,
    private readonly values: FoundryTestExplorerValues,
  ) {}

  reconcile(project: string, model: TestDiscoveryModel): void {
    const desired = model.items.map((record, order): DesiredItem => ({
      record,
      nativePath: resolveNativePath(project, record.resourcePath),
      order,
    }));
    const desiredById = new Map(
      desired.map((item) => [item.record.id, item] as const),
    );
    const recreate = new Set<string>();
    for (const item of desired) {
      const previous = this.metadata.get(item.record.id);
      if (
        previous !== undefined &&
        (previous.kind !== item.record.kind ||
          this.nativePaths.get(item.record.id) !== item.nativePath)
      ) {
        recreate.add(item.record.id);
      }
    }

    const detach = new Set<string>();
    for (const [id, previous] of this.metadata) {
      const next = desiredById.get(id);
      if (
        next === undefined ||
        recreate.has(id) ||
        previous.parentId !== next.record.parentId ||
        (next.record.parentId !== null && recreate.has(next.record.parentId))
      ) {
        detach.add(id);
      }
    }
    this.detachChildFirst(detach);

    for (const id of this.items.keys()) {
      if (!desiredById.has(id) || recreate.has(id)) {
        this.items.delete(id);
        this.metadata.delete(id);
        this.nativePaths.delete(id);
      }
    }

    for (const desiredItem of desired) {
      const { record, nativePath, order } = desiredItem;
      let item = this.items.get(record.id);
      const created = item === undefined;
      if (item === undefined) {
        item = this.controller.createTestItem(
          record.id,
          record.label,
          nativePath === null ? undefined : this.values.createUri(nativePath),
        );
        this.items.set(record.id, item);
      }

      updateItem(item, record, order, this.values);
      this.metadata.set(record.id, metadataFor(record));
      this.nativePaths.set(record.id, nativePath);

      if (created || detach.has(record.id)) {
        this.collectionFor(record.parentId).add(item);
      }
    }
    this.model = model;
  }

  clear(): void {
    this.controller.items.replace([]);
    this.items.clear();
    this.metadata.clear();
    this.nativePaths.clear();
    this.model = undefined;
  }

  getMetadata(id: string): FoundryTestItemMetadata | undefined {
    return this.metadata.get(id);
  }

  snapshot(): FoundryTestExplorerSnapshot | undefined {
    if (this.model === undefined) {
      return undefined;
    }
    const items = new Map(this.items);
    return {
      model: this.model,
      item: (id) => items.get(id),
    };
  }

  private detachChildFirst(ids: ReadonlySet<string>): void {
    const ordered = [...ids].sort(
      (left, right) => this.depth(right) - this.depth(left),
    );
    for (const id of ordered) {
      const parentId = this.metadata.get(id)?.parentId ?? null;
      this.collectionFor(parentId).delete(id);
    }
  }

  private depth(id: string): number {
    let depth = 0;
    let parentId = this.metadata.get(id)?.parentId ?? null;
    const visited = new Set<string>();
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = this.metadata.get(parentId)?.parentId ?? null;
    }
    return depth;
  }

  private collectionFor(parentId: string | null): vscode.TestItemCollection {
    if (parentId === null) {
      return this.controller.items;
    }
    const parent = this.items.get(parentId);
    if (parent === undefined) {
      throw new Error(`Discovery parent ${JSON.stringify(parentId)} is unavailable.`);
    }
    return parent.children;
  }
}

function resolveNativePath(
  project: string,
  resourcePath: string | null,
): string | null {
  if (resourcePath === null) {
    return null;
  }
  return path.join(project, resourcePath.slice("res://".length));
}

function updateItem(
  item: vscode.TestItem,
  record: TestDiscoveryItem,
  order: number,
  values: FoundryTestExplorerValues,
): void {
  item.label = record.label;
  item.range = record.range === null ? undefined : values.createRange(record.range);
  item.sortText = String(order).padStart(9, "0");
  if (record.kind === "error") {
    item.description = "Discovery error";
    item.error = record.message;
    return;
  }
  item.error = undefined;
  if (record.skipped) {
    item.description = `Skipped: ${record.skipReason ?? ""}`;
  } else if (!record.runnable) {
    item.description = "Not runnable";
  } else {
    Object.assign(item, { description: undefined });
  }
}

function metadataFor(record: TestDiscoveryItem): FoundryTestItemMetadata {
  if (record.kind === "error") {
    return {
      kind: record.kind,
      parentId: record.parentId,
      resourcePath: record.resourcePath,
      runnable: false,
      skipped: false,
      skipReason: null,
      caseKey: null,
    };
  }
  return {
    kind: record.kind,
    parentId: record.parentId,
    resourcePath: record.resourcePath,
    runnable: record.runnable,
    skipped: record.skipped,
    skipReason: record.skipReason,
    caseKey: record.kind === "test" ? record.caseKey : null,
  };
}
