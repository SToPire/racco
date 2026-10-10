export interface GraphCommit {
  oid: string;
  parents: readonly string[];
  boundaryParents: readonly string[];
}

export interface GitGraphEdge {
  fromLane: number;
  toLane: number;
  from: "top" | "node";
  to: "node" | "bottom" | "boundary";
  color: number;
  parentOid: string;
}

export interface GitGraphRow {
  oid: string;
  lane: number;
  color: number;
  kind: "commit" | "merge" | "root";
  edges: GitGraphEdge[];
}

export interface GitGraphSpan {
  startRow: number;
  endRow: number | null;
  color: number;
  parentOid: string;
}

export const GIT_GRAPH_MAX_LANES = 512;
export const GIT_GRAPH_MAX_PARENT_EDGES = 50_000;
export type GitGraphLimit = "lanes" | "edges";

export interface GitCommitGraph {
  rows: GitGraphRow[];
  laneCount: number;
  spansByLane: GitGraphSpan[][];
  limit: GitGraphLimit | null;
}

type PendingCommit = { oid: string; color: number; span: GitGraphSpan };

/** Expand vertical continuations only for a row the caller will render. */
export function getCommitGraphEdges(
  graph: GitCommitGraph,
  rowIndex: number,
): GitGraphEdge[] {
  if (graph.limit !== null) return [];
  const edges: GitGraphEdge[] = [];
  for (const [lane, spans] of graph.spansByLane.entries()) {
    // A lane is reused across disjoint chronological spans. Find the last
    // allocation at or before this row without scanning its entire history.
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (spans[middle].startRow <= rowIndex) low = middle + 1;
      else high = middle;
    }
    const span = spans[low - 1];
    if (!span || (span.endRow !== null && rowIndex >= span.endRow)) continue;
    edges.push({
      fromLane: lane,
      toLane: lane,
      from: "top",
      to: "bottom",
      color: span.color,
      parentOid: span.parentOid,
    });
  }
  return [...edges, ...graph.rows[rowIndex].edges];
}

// A min-heap reuses the leftmost free lane without repeatedly scanning every
// occupied lane for each parent of an octopus merge.
class FreeLanes {
  private heap: number[] = [];
  count = 0;

  take(): number {
    if (this.heap.length === 0) return this.count++;
    const first = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      let index = 0;
      while (index * 2 + 1 < this.heap.length) {
        let child = index * 2 + 1;
        if (
          child + 1 < this.heap.length &&
          this.heap[child + 1] < this.heap[child]
        ) {
          child++;
        }
        if (last <= this.heap[child]) break;
        this.heap[index] = this.heap[child];
        index = child;
      }
      this.heap[index] = last;
    }
    return first;
  }

  release(lane: number): void {
    let index = this.heap.length;
    this.heap.push(lane);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.heap[parent] <= lane) break;
      this.heap[index] = this.heap[parent];
      index = parent;
    }
    this.heap[index] = lane;
  }
}

/**
 * Lay out a topologically ordered prefix without looking ahead. Appending
 * commits therefore cannot change any previously returned row or color.
 * Pending parents continue through the bottom of a row; only explicit object
 * boundaries terminate. Rows store only incoming and actual parent edges;
 * waiting lanes share spans rather than duplicating an edge in every row.
 * Storage is O(commits + parent edges), independent of a lane's waiting time.
 */
export function layoutCommitGraph(
  commits: readonly GraphCommit[],
): GitCommitGraph {
  const lanes = new FreeLanes();
  const active = new Map<number, PendingCommit>();
  const byOid = new Map<string, number>();
  const visited = new Set<string>();
  const rows: GitGraphRow[] = [];
  const spansByLane: GitGraphSpan[][] = [];
  let nextColor = 0;
  let parentEdgeCount = 0;
  const limited = (limit: GitGraphLimit): GitCommitGraph => ({
    rows: [],
    laneCount: 0,
    spansByLane: [],
    limit,
  });

  for (const [rowIndex, commit] of commits.entries()) {
    if (visited.has(commit.oid)) {
      throw new Error("Commit graph contains a duplicate commit");
    }
    visited.add(commit.oid);
    const parents = [...new Set(commit.parents)];
    parentEdgeCount += parents.length;
    if (parentEdgeCount > GIT_GRAPH_MAX_PARENT_EDGES) return limited("edges");
    const boundaryParents = new Set(commit.boundaryParents);
    if (parents.some((oid) => !boundaryParents.has(oid) && visited.has(oid))) {
      throw new Error("Commit graph must be topologically ordered");
    }
    const occupiedLane = byOid.get(commit.oid);
    const lane = occupiedLane ?? lanes.take();
    if (lane >= GIT_GRAPH_MAX_LANES) return limited("lanes");
    const color =
      occupiedLane === undefined ? nextColor++ : active.get(lane)!.color;
    const row: GitGraphRow = {
      oid: commit.oid,
      lane,
      color,
      kind:
        parents.length === 0 ? "root" : parents.length > 1 ? "merge" : "commit",
      edges: [],
    };

    const pending = active.get(lane);
    if (pending) {
      pending.span.endRow = rowIndex;
      row.edges.push({
        fromLane: lane,
        toLane: lane,
        from: "top",
        to: "node",
        color: pending.color,
        parentOid: pending.oid,
      });
    }
    active.delete(lane);
    byOid.delete(commit.oid);

    // Reserve the node lane until every parent is assigned, including terminal
    // boundaries. No other parent can steal the first parent's continuation.
    let continuesNodeLane = false;
    const terminalLanes: number[] = [];
    for (const [index, parentOid] of parents.entries()) {
      const boundary = boundaryParents.has(parentOid);
      const existingLane = boundary ? undefined : byOid.get(parentOid);
      const parentLane = existingLane ?? (index === 0 ? lane : lanes.take());
      if (parentLane >= GIT_GRAPH_MAX_LANES) return limited("lanes");
      const parentColor =
        existingLane !== undefined
          ? active.get(existingLane)!.color
          : index === 0
            ? color
            : nextColor++;

      row.edges.push({
        fromLane: lane,
        toLane: parentLane,
        from: "node",
        to: boundary ? "boundary" : "bottom",
        color: parentColor,
        parentOid,
      });
      if (boundary) {
        if (parentLane !== lane) terminalLanes.push(parentLane);
      } else if (existingLane === undefined) {
        const span: GitGraphSpan = {
          startRow: rowIndex + 1,
          endRow: null,
          color: parentColor,
          parentOid,
        };
        while (spansByLane.length <= parentLane) spansByLane.push([]);
        spansByLane[parentLane].push(span);
        active.set(parentLane, { oid: parentOid, color: parentColor, span });
        byOid.set(parentOid, parentLane);
        if (parentLane === lane) continuesNodeLane = true;
      }
    }
    if (!continuesNodeLane) lanes.release(lane);
    for (const terminalLane of terminalLanes) lanes.release(terminalLane);
    rows.push(row);
  }

  return { rows, laneCount: lanes.count, spansByLane, limit: null };
}
