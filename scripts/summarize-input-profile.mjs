import fs from "node:fs/promises";
import path from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

const directory = path.resolve(process.argv[2]);
const report = JSON.parse(await fs.readFile(path.join(directory, "report.json"), "utf8"));
const maps = new Map();
async function mapFor(url) {
  const file = path.basename(url);
  if (!maps.has(file)) {
    try { maps.set(file, new TraceMap(JSON.parse(await fs.readFile(path.join(report.frontend, "assets", file + ".map"), "utf8")))); }
    catch { maps.set(file, null); }
  }
  return maps.get(file);
}
const summaries = [];
for (const name of (await fs.readdir(directory)).filter(file => file.endsWith("-typing.cpuprofile"))) {
  const profile = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map();
  const labels = new Map();
  for (const node of nodes.values()) {
    for (const child of node.children || []) parents.set(child, node.id);
    const frame = node.callFrame, map = await mapFor(frame.url);
    const original = map && frame.lineNumber >= 0 ? originalPositionFor(map, { line: frame.lineNumber + 1, column: frame.columnNumber }) : null;
    labels.set(node.id, { name: original?.name || frame.functionName || "(익명)", file: original?.source || frame.url, line: original?.line || frame.lineNumber + 1 });
  }
  const self = new Map(), inclusive = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i], ms = profile.timeDeltas[i] / 1000;
    const label = labels.get(id), key = JSON.stringify(label);
    self.set(key, (self.get(key) || 0) + ms);
    const seen = new Set();
    for (let current = id; current; current = parents.get(current)) {
      const file = labels.get(current).file;
      if (!file || seen.has(file)) continue;
      inclusive.set(file, (inclusive.get(file) || 0) + ms); seen.add(file);
    }
  }
  const summary = {
    profile: name,
    self: [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([key, ms]) => ({ ...JSON.parse(key), ms })),
    inclusiveByFile: [...inclusive].sort((a, b) => b[1] - a[1]).map(([file, ms]) => ({ file, ms })),
  };
  summaries.push(summary);
}
await fs.writeFile(path.join(directory, "profile-summary.json"), JSON.stringify(summaries, null, 2));
for (const summary of summaries) console.log(JSON.stringify(summary, null, 2));
