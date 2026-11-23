// The branching picture of a run. Every line on it has to come from a
// recorded step, and a step that failed must not be drawn coming back.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "src", "lib", "worklines.ts"));
const ev = (at, tool, ok = true, kind = "tool") => ({
  at, tool, ok, kind, agent_id: "a1", agent_name: "Theo", input: "", detail: "",
});

test("nothing recorded draws nothing", async () => {
  const { graphOf } = await load();
  assert.deepEqual(graphOf([]), { nodes: [], branches: [], length: 0 });
  assert.equal(graphOf([ev(1, null, true, "note")]).nodes.length, 0, "only tool steps are branches");
});

test("one branch per recorded step, in the order they happened", async () => {
  const { graphOf } = await load();
  const g = graphOf([ev(300, "write_file"), ev(100, "web_search"), ev(200, "read_file")]);
  assert.deepEqual(g.nodes.map((n) => n.label), ["web search", "read file", "write file"]);
  assert.equal(g.branches.length, 3);
});

test("a step that failed stops where it stopped, and does not rejoin", async () => {
  const { graphOf } = await load();
  const g = graphOf([ev(1, "web_search", false), ev(2, "read_file", true)]);
  assert.equal(g.branches[0].to, g.branches[0].from, "a failure does not come back with anything");
  assert.equal(g.branches[1].to, g.branches[1].from + 1);
});

test("the trunk carries on past the last step", async () => {
  const { graphOf } = await load();
  const g = graphOf([ev(1, "a"), ev(2, "b")]);
  assert.equal(g.length, 3, "two steps, and somewhere for the second branch to rejoin");
  assert.ok(g.branches.every((b) => b.to <= g.length - 1), "no branch rejoins off the end of the drawing");
});

test("only the most recent steps are drawn, and they are the most recent ones", async () => {
  const { graphOf } = await load();
  const many = Array.from({ length: 40 }, (_, i) => ev(i, `tool_${i}`));
  const g = graphOf(many, 5);
  assert.equal(g.nodes.length, 5);
  assert.deepEqual(g.nodes.map((n) => n.label), ["tool 35", "tool 36", "tool 37", "tool 38", "tool 39"]);
});

test("branches alternate above and below so they do not sit on top of each other", async () => {
  const { graphOf } = await load();
  const g = graphOf([ev(1, "a"), ev(2, "b"), ev(3, "c"), ev(4, "d")]);
  const lanes = g.branches.map((b) => b.lane);
  assert.equal(new Set(lanes).size, 4);
  assert.ok(lanes.some((l) => l < 0) && lanes.some((l) => l > 0));
});

test("positions are evenly spaced inside the drawing", async () => {
  const { xAt } = await load();
  assert.equal(xAt(0, 5, 640), 28);
  assert.equal(xAt(4, 5, 640), 612);
  const gaps = [1, 2, 3, 4].map((i) => xAt(i, 5, 640) - xAt(i - 1, 5, 640));
  assert.ok(gaps.every((g) => Math.abs(g - gaps[0]) < 1e-9), "order, evenly spaced");
  assert.equal(xAt(0, 1, 640), 28, "one step does not divide by zero");
});

test("the drawing says it is an order and not a timeline", () => {
  const ui = fs.readFileSync(path.join(__dirname, "..", "src", "components", "WorkGraph.tsx"), "utf8");
  // Spacing is by step, so anybody reading width as duration would be reading
  // something nobody measured. The interface has to say so.
  assert.match(ui, /not how long/i);
});
