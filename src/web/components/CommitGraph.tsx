import {
  getCommitGraphEdges,
  type GitCommitGraph,
  type GitGraphEdge,
} from "../commit-graph.js";

const LANE_WIDTH = 14;
const PADDING = 8;
const COLORS = [
  "var(--git-graph-blue, #3878c5)",
  "var(--git-graph-purple, #9862c6)",
  "var(--git-graph-green, #328467)",
  "var(--git-graph-orange, #bd7137)",
  "var(--git-graph-pink, #bb5187)",
  "var(--git-graph-cyan, #268495)",
];

function laneX(lane: number): number {
  return PADDING + lane * LANE_WIDTH;
}

function edgePath(edge: GitGraphEdge, height: number, nodeY: number): string {
  const fromX = laneX(edge.fromLane);
  const toX = laneX(edge.toLane);
  const fromY = edge.from === "top" ? 0 : nodeY;
  const toY =
    edge.to === "node"
      ? nodeY
      : edge.to === "boundary"
        ? nodeY + (height - nodeY) * 0.72
        : height;
  if (fromX === toX) return `M${fromX},${fromY}V${toY}`;
  const middleY = (fromY + toY) / 2;
  return `M${fromX},${fromY}C${fromX},${middleY} ${toX},${middleY} ${toX},${toY}`;
}

export function CommitGraph({
  graph,
  rowIndex,
  height,
  nodeY,
}: {
  graph: GitCommitGraph;
  rowIndex: number;
  height: number;
  nodeY: number;
}) {
  if (graph.limit !== null) return null;
  const row = graph.rows[rowIndex];
  const edges = getCommitGraphEdges(graph, rowIndex);
  const width = PADDING * 2 + (Math.max(1, graph.laneCount) - 1) * LANE_WIDTH;
  const color = COLORS[row.color % COLORS.length];
  return (
    <svg
      className="commit-graph"
      aria-hidden="true"
      focusable="false"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block", flexShrink: 0, width, height }}
    >
      {edges.map((edge, index) => (
        <path
          key={index}
          d={edgePath(edge, height, nodeY)}
          fill="none"
          stroke={COLORS[edge.color % COLORS.length]}
          strokeWidth={1.5}
          strokeDasharray={edge.to === "boundary" ? "3 2" : undefined}
        />
      ))}
      {row.edges
        .filter((edge) => edge.to === "boundary")
        .map((edge) => {
          const x = laneX(edge.toLane);
          const y = nodeY + (height - nodeY) * 0.72;
          return (
            <path
              key={edge.parentOid}
              d={`M${x},${y - 3}l3,3 -3,3 -3,-3Z`}
              fill="var(--surface, white)"
              stroke={COLORS[edge.color % COLORS.length]}
              strokeWidth={1.5}
            />
          );
        })}
      <circle
        data-kind={row.kind}
        cx={laneX(row.lane)}
        cy={nodeY}
        r={row.kind === "merge" ? 4 : 3}
        fill={row.kind === "merge" ? "var(--surface, white)" : color}
        stroke={color}
        strokeWidth={1.5}
      />
    </svg>
  );
}
