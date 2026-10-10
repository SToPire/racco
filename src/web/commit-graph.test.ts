import assert from "node:assert/strict";
import test from "node:test";
import {
  layoutCommitGraph,
  getCommitGraphEdges,
  type GraphCommit,
  type GitCommitGraph,
} from "./commit-graph.js";

function commit(
  oid: string,
  parents: string[] = [],
  boundaryParents: string[] = [],
): GraphCommit {
  return { oid, parents, boundaryParents };
}

// Follow each visible parent edge across row boundaries. A real parent must
// end at its own node, never at a nearby branch or an unrelated root.
function assertParentConnections(graph: GitCommitGraph): void {
  const rows = graph.rows.map((row, index) => ({
    ...row,
    edges: getCommitGraphEdges(graph, index),
  }));
  for (const [childIndex, row] of rows.entries()) {
    for (const edge of row.edges) {
      if (edge.from !== "node" || edge.to !== "bottom") continue;
      let lane = edge.toLane;
      let color = edge.color;
      for (let index = childIndex + 1; index < rows.length; index++) {
        const next = rows[index];
        const continuation = next.edges.find(
          (candidate) =>
            candidate.from === "top" && candidate.fromLane === lane,
        );
        assert.ok(
          continuation,
          `${row.oid} -> ${edge.parentOid} at ${next.oid}`,
        );
        assert.equal(continuation.parentOid, edge.parentOid);
        assert.equal(continuation.color, color);
        if (continuation.to === "node") {
          assert.equal(next.oid, edge.parentOid);
          assert.equal(next.lane, continuation.toLane);
          break;
        }
        assert.notEqual(next.oid, edge.parentOid);
        assert.equal(continuation.to, "bottom");
        lane = continuation.toLane;
        color = continuation.color;
      }
    }
  }
}

test("linear commits continue in one lane and only the actual root terminates", () => {
  const graph = layoutCommitGraph([
    commit("tip", ["middle"]),
    commit("middle", ["root"]),
    commit("root"),
  ]);
  assert.equal(graph.laneCount, 1);
  assert.deepEqual(
    graph.rows.map(({ lane, color, kind }) => ({ lane, color, kind })),
    [
      { lane: 0, color: 0, kind: "commit" },
      { lane: 0, color: 0, kind: "commit" },
      { lane: 0, color: 0, kind: "root" },
    ],
  );
  assert.equal(
    graph.rows[2].edges.some((edge) => edge.to === "bottom"),
    false,
  );
  assertParentConnections(graph);
});

test("a merge splits into real parent lanes and rejoins the common ancestor", () => {
  const graph = layoutCommitGraph([
    commit("merge", ["left", "right"]),
    commit("left", ["base"]),
    commit("right", ["base"]),
    commit("base"),
  ]);
  assert.equal(graph.laneCount, 2);
  assert.deepEqual(
    graph.rows.map((row) => row.lane),
    [0, 0, 1, 0],
  );
  assert.equal(graph.rows[0].kind, "merge");
  const rejoin = graph.rows[2].edges.find((edge) => edge.from === "node");
  assert.equal(rejoin?.fromLane, 1);
  assert.equal(rejoin?.toLane, 0);
  assert.equal(rejoin?.parentOid, "base");
  assertParentConnections(graph);
});

test("multiple branch tips join occupied parent lanes without duplicating them", () => {
  const graph = layoutCommitGraph([
    commit("tip-one", ["a", "b"]),
    commit("tip-two", ["b", "c"]),
    commit("a", ["base"]),
    commit("b", ["base"]),
    commit("c", ["base"]),
    commit("base"),
  ]);
  const bLane = graph.rows.find((row) => row.oid === "b")!.lane;
  for (const row of graph.rows.slice(0, 2)) {
    const toB = row.edges.find(
      (edge) => edge.from === "node" && edge.parentOid === "b",
    );
    assert.equal(toB?.toLane, bLane);
  }
  assertParentConnections(graph);
});

test("octopus merges preserve every parent and first-parent continuity", () => {
  const parents = Array.from({ length: 12 }, (_, index) => `parent-${index}`);
  const graph = layoutCommitGraph([
    commit("octopus", parents),
    ...parents.map((oid) => commit(oid, ["base"])),
    commit("base"),
  ]);
  assert.equal(graph.laneCount, parents.length);
  assert.equal(graph.rows[0].edges.length, parents.length);
  assert.deepEqual(
    graph.rows[0].edges.map((edge) => edge.parentOid),
    parents,
  );
  assert.equal(graph.rows[0].lane, graph.rows[1].lane);
  assert.equal(graph.rows.at(-1)?.lane, graph.rows[0].lane);
  assertParentConnections(graph);
});

test("duplicate parents do not allocate duplicate lanes or extra edges", () => {
  const graph = layoutCommitGraph([
    commit("merge", ["a", "a", "b", "a"]),
    commit("a", ["base"]),
    commit("b", ["base"]),
    commit("base"),
  ]);
  assert.equal(graph.laneCount, 2);
  assert.deepEqual(
    graph.rows[0].edges.map((edge) => edge.parentOid),
    ["a", "b"],
  );
  assertParentConnections(graph);
});

test("unloaded parents continue while explicit boundaries end with their own marker", () => {
  const pending = layoutCommitGraph([commit("tip", ["unloaded"])]);
  assert.equal(pending.rows[0].kind, "commit");
  assert.equal(pending.rows[0].edges[0].to, "bottom");

  const graph = layoutCommitGraph([
    commit(
      "shallow",
      ["missing-one", "missing-two"],
      ["missing-one", "missing-two"],
    ),
    commit("unrelated-root"),
  ]);
  assert.equal(graph.rows[0].kind, "merge");
  assert.equal(graph.rows[0].edges.length, 2);
  assert.ok(graph.rows[0].edges.every((edge) => edge.to === "boundary"));
  assert.deepEqual(graph.rows[1].edges, []);
  assert.equal(graph.rows[1].lane, 0);
});

test("a missing first parent does not terminate an available second parent", () => {
  const graph = layoutCommitGraph([
    commit("merge", ["missing", "available"], ["missing"]),
    commit("available", ["base"]),
    commit("base"),
  ]);
  assert.equal(graph.rows[0].edges[0].to, "boundary");
  assert.equal(graph.rows[0].edges[1].to, "bottom");
  assert.equal(graph.rows[1].lane, graph.rows[0].edges[1].toLane);
  assertParentConnections(graph);
});

test("appending 15-commit batches preserves every existing node, edge and color", () => {
  const commits = Array.from({ length: 76 }, (_, index) => {
    const parents = index < 75 ? [`commit-${index + 1}`] : [];
    if (index >= 15 && index % 7 === 0 && index + 6 < 76) {
      parents.push(`commit-${index + 6}`);
    }
    return commit(`commit-${index}`, parents);
  });
  let previous = layoutCommitGraph([]);
  for (const length of [15, 30, 45, 60, 75, 76]) {
    const graph = layoutCommitGraph(commits.slice(0, length));
    assert.deepEqual(graph.rows.slice(0, previous.rows.length), previous.rows);
    for (let index = 0; index < previous.rows.length; index++) {
      assert.deepEqual(
        getCommitGraphEdges(graph, index),
        getCommitGraphEdges(previous, index),
      );
    }
    assert.ok(graph.laneCount >= previous.laneCount);
    assertParentConnections(graph);
    previous = graph;
  }
});

test("released lanes are reused without moving waiting ancestors", () => {
  const graph = layoutCommitGraph([
    commit("merge", ["long-branch", "root-one", "root-two", "root-three"]),
    commit("root-two"),
    commit("root-one"),
    commit("new-tip", ["new-root"]),
    commit("new-root"),
    commit("root-three"),
    commit("long-branch"),
  ]);
  assert.equal(graph.rows[3].lane, 1);
  assert.equal(graph.rows[5].lane, 3);
  assert.equal(graph.rows[6].lane, 0);
  assert.equal(graph.laneCount, 4);
  assertParentConnections(graph);
});

test("5000 linear commits need one lane and a linear number of edges", () => {
  const commits = Array.from({ length: 5000 }, (_, index) =>
    commit(String(index), index < 4999 ? [String(index + 1)] : []),
  );
  const graph = layoutCommitGraph(commits);
  assert.equal(graph.rows.length, 5000);
  assert.equal(graph.laneCount, 1);
  assert.equal(
    graph.rows.reduce((count, row) => count + row.edges.length, 0),
    9998,
  );
});

test("empty histories have no lanes and invalid topology is rejected", () => {
  assert.deepEqual(layoutCommitGraph([]), {
    rows: [],
    laneCount: 0,
    spansByLane: [],
    limit: null,
  });
  assert.throws(
    () => layoutCommitGraph([commit("a"), commit("a")]),
    /duplicate/,
  );
  assert.throws(
    () => layoutCommitGraph([commit("a"), commit("b", ["a"])]),
    /topologically/,
  );
});

test("a shallow boundary can name a separately reachable commit shown earlier", () => {
  const graph = layoutCommitGraph([
    commit("separately-reachable"),
    commit("shallow-tip", ["separately-reachable"], ["separately-reachable"]),
  ]);
  assert.equal(graph.rows[1].edges[0].to, "boundary");
  assert.deepEqual(graph.spansByLane, []);
});

test("512 concurrent lanes retain spans rather than a through edge per row", () => {
  const width = 512;
  const depth = 4;
  const commits = [
    commit(
      "merge",
      Array.from({ length: width }, (_, lane) => `0-${lane}`),
    ),
  ];
  for (let layer = 0; layer < depth; layer++) {
    for (let lane = 0; lane < width; lane++) {
      commits.push(
        commit(`${layer}-${lane}`, [
          layer + 1 < depth ? `${layer + 1}-${lane}` : "root",
        ]),
      );
    }
  }
  commits.push(commit("root"));
  const graph = layoutCommitGraph(commits);
  assert.equal(graph.laneCount, width);
  assert.equal(graph.rows.length, 2050);
  const edgeCount = graph.rows.reduce(
    (count, row) => count + row.edges.length,
    0,
  );
  const spanCount = graph.spansByLane.reduce(
    (count, spans) => count + spans.length,
    0,
  );
  assert.equal(edgeCount, 4609);
  assert.equal(spanCount, 2049);
  // The visible middle row still has every crossing lane and its two own edges.
  assert.equal(getCommitGraphEdges(graph, 1024).length, 513);
  assert.equal(getCommitGraphEdges(graph, 2049).length, 1);
});

test("dense single commits return an explicit graph limit without partial edges", () => {
  const parents = Array.from(
    { length: 10_000 },
    (_, index) => `parent-${index}`,
  );
  const graph = layoutCommitGraph([commit("dense", parents)]);
  assert.equal(graph.limit, "lanes");
  assert.deepEqual(graph.rows, []);
  assert.deepEqual(graph.spansByLane, []);
  assert.deepEqual(getCommitGraphEdges(graph, 0), []);
});

test("many merges also respect a total parent-edge budget", () => {
  const parents = Array.from({ length: 500 }, (_, index) => `parent-${index}`);
  const commits = [
    ...Array.from({ length: 101 }, (_, index) =>
      commit(`merge-${index}`, parents),
    ),
    ...parents.map((oid) => commit(oid)),
  ];
  const graph = layoutCommitGraph(commits);
  assert.equal(graph.limit, "edges");
  assert.deepEqual(graph.rows, []);
  assert.deepEqual(graph.spansByLane, []);
});
