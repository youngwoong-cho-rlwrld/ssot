import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { Vector3 } from "three";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { allex48Values } from "../src/allexMapping";
import { vectorFromUnknown } from "../src/mapping";
import { computePose, parseUrdf } from "../src/urdf";

type RefPoint = { id: number; name: string; xyz: [number, number, number] };
type KeypointDef = { id: number; name: string; link: string };

const root = new URL("../", import.meta.url);
const workspace = new URL("../", root);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchJson(text: string, start: number, open: string, close: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error("unmatched JSON");
}

function decodeArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (!isRecord(value) || typeof value.bdata !== "string") return [];
  const buffer = Buffer.from(value.bdata, "base64");
  const out = [];
  for (let offset = 0; offset < buffer.byteLength; offset += 8) out.push(buffer.readDoubleLE(offset));
  return out;
}

function refPointsFromHtml(html: string): RefPoint[] {
  const call = html.lastIndexOf("Plotly.newPlot(");
  const dataStart = html.indexOf("[", call);
  const data = JSON.parse(matchJson(html, dataStart, "[", "]"));
  const points: RefPoint[] = [];
  for (const trace of data) {
    if (!Array.isArray(trace.text)) continue;
    const xs = decodeArray(trace.x);
    const ys = decodeArray(trace.y);
    const zs = decodeArray(trace.z);
    trace.text.forEach((label: string, index: number) => {
      const hit = label.match(/^id (\d+) · (.+)$/);
      if (!hit) return;
      points.push({ id: Number(hit[1]), name: hit[2], xyz: [xs[index], ys[index], zs[index]] });
    });
  }
  return points.sort((a, b) => a.id - b.id);
}

function keypointDefs(text: string): KeypointDef[] {
  return Array.from(text.matchAll(/KeypointDef\(\s*(\d+),\s*"([^"]+)",\s*"([^"]+)"/g), (m) => ({
    id: Number(m[1]),
    name: m[2],
    link: m[3],
  }));
}

function format(values: number[]) {
  return `[${values.map((value) => value.toFixed(6)).join(", ")}]`;
}

const [html, keypointText, urdfText, parquetBuffer] = await Promise.all([
  readFile(new URL("fk_html_handoff/example_fk_interactive.html", workspace), "utf8"),
  readFile(new URL("fk_html_handoff/fk_keypoints/keypoint_definition.py", workspace), "utf8"),
  readFile(new URL("public/assets/default/allex.urdf", root), "utf8"),
  readFile(new URL("public/assets/default/episode_000000.parquet", root)),
]);

const parquetFile = parquetBuffer.buffer.slice(parquetBuffer.byteOffset, parquetBuffer.byteOffset + parquetBuffer.byteLength);
const rows = (await parquetReadObjects({ file: parquetFile, compressors })) as Record<string, unknown>[];
const obs48 = vectorFromUnknown(rows[0]?.["observation.state"]);
if (!obs48) throw new Error("observation.state is missing or is not numeric.");
const model = parseUrdf(urdfText);
const { linkMatrices } = computePose(model, allex48Values(obs48, "carrier-yaw-pitch"));
const ref = refPointsFromHtml(html);
const refByName = new Map(ref.map((point) => [point.name, point]));
const defs = keypointDefs(keypointText);

const rowsOut = defs
  .map((def) => {
    const frame = linkMatrices.get(def.link);
    const refPoint = refByName.get(def.name);
    if (!frame || !refPoint) return null;
    const pos = new Vector3().setFromMatrixPosition(frame);
    const actual = [pos.x, pos.y, pos.z];
    const delta = actual.map((value, index) => value - refPoint.xyz[index]);
    return {
      id: def.id,
      name: def.name,
      link: def.link,
      ref: refPoint.xyz,
      actual,
      delta,
      maxAbs: Math.max(...delta.map(Math.abs)),
    };
  })
  .filter((item): item is NonNullable<typeof item> => Boolean(item))
  .sort((a, b) => a.id - b.id);

console.log(`frame=0 compared=${rowsOut.length}`);
console.log("id  name                         fk_html_handoff [x,y,z]                 viewer_js [x,y,z]                      delta [x,y,z]");
for (const row of rowsOut.filter((item) => [0, 1, 2, 3, 5, 6, 7, 13, 34, 40, 41, 60].includes(item.id))) {
  console.log(
    `${String(row.id).padStart(2)}  ${row.name.padEnd(28)} ${format(row.ref).padEnd(38)} ${format(row.actual).padEnd(38)} ${format(row.delta)}`,
  );
}

const worst = [...rowsOut].sort((a, b) => b.maxAbs - a.maxAbs).slice(0, 12);
console.log("\nworst deltas:");
for (const row of worst) {
  console.log(`${String(row.id).padStart(2)}  ${row.name.padEnd(28)} max=${row.maxAbs.toFixed(6)}  delta=${format(row.delta)}`);
}

const max = worst[0]?.maxAbs ?? 0;
console.log(`\nmax_abs_delta=${max.toFixed(9)} m`);
