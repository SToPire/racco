import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { layoutCommitGraph } from "../commit-graph.js";
import { CommitGraph } from "./CommitGraph.js";

test("graph coordinates do not rescale when subsequent rows need more lanes", () => {
  const graph = layoutCommitGraph([
    { oid: "tip", parents: ["parent"], boundaryParents: [] },
  ]);
  const narrow = renderToStaticMarkup(
    <CommitGraph graph={graph} rowIndex={0} height={32} nodeY={16} />,
  );
  const wide = renderToStaticMarkup(
    <CommitGraph
      graph={{ ...graph, laneCount: 8 }}
      rowIndex={0}
      height={32}
      nodeY={16}
    />,
  );
  assert.match(narrow, /width="16" height="32" viewBox="0 0 16 32"/);
  assert.match(wide, /width="114" height="32" viewBox="0 0 114 32"/);
  for (const markup of [narrow, wide]) {
    assert.match(markup, /d="M8,16V32"/);
    assert.match(markup, /cx="8" cy="16"/);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /focusable="false"/);
  }
});

test("missing parent edges have a dashed line and diamond distinct from commit nodes", () => {
  const graph = layoutCommitGraph([
    { oid: "tip", parents: ["missing"], boundaryParents: ["missing"] },
  ]);
  const markup = renderToStaticMarkup(
    <CommitGraph graph={graph} rowIndex={0} height={50} nodeY={25} />,
  );
  assert.match(markup, /stroke-dasharray="3 2"/);
  assert.match(markup, /d="M8,40l3,3 -3,3 -3,-3Z"/);
  assert.match(markup, /data-kind="commit"/);
  assert.doesNotMatch(markup, /data-kind="root"/);
});

test("rows with refs keep the node on the title and continue edges through the labels", () => {
  const graph = layoutCommitGraph([
    { oid: "tip", parents: ["parent"], boundaryParents: [] },
    { oid: "parent", parents: [], boundaryParents: [] },
  ]);
  const withRefs = renderToStaticMarkup(
    <CommitGraph graph={graph} rowIndex={0} height={60} nodeY={16} />,
  );
  const plain = renderToStaticMarkup(
    <CommitGraph graph={graph} rowIndex={1} height={32} nodeY={16} />,
  );
  assert.match(withRefs, /height="60" viewBox="0 0 16 60"/);
  assert.match(withRefs, /d="M8,16V60"/);
  assert.match(withRefs, /cx="8" cy="16"/);
  assert.match(plain, /d="M8,0V16"/);
});

test("a resource-limited graph does not render an incomplete DAG", () => {
  const graph = layoutCommitGraph([
    {
      oid: "dense",
      parents: Array.from({ length: 513 }, (_, index) => `parent-${index}`),
      boundaryParents: [],
    },
  ]);
  assert.equal(graph.limit, "lanes");
  assert.equal(
    renderToStaticMarkup(
      <CommitGraph graph={graph} rowIndex={0} height={32} nodeY={16} />,
    ),
    "",
  );
});
