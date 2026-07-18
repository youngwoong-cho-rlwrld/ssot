// Minimal, dependency-free YAML reader for the read-only "UI" view of the
// experiment YAML files (data_config.yaml, gam_config.yaml). It understands the
// block subset those configs use — nested mappings, block sequences of scalars,
// flow sequences/mappings, and scalar coercion — and throws on anything it does
// not recognize so the caller can fall back to the raw code view. It is NOT a
// general YAML parser and never round-trips back to text.

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

type Line = { indent: number; text: string };

/** Parse the supported YAML subset. Throws on unsupported constructs. */
export function parseSimpleYaml(source: string): YamlValue {
  const lines = tokenize(source);
  if (lines.length === 0) return {};
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) {
    throw new Error(`unexpected indentation at line ${next + 1}`);
  }
  return value;
}

function tokenize(source: string): Line[] {
  const out: Line[] = [];
  for (const raw of source.split("\n")) {
    const stripped = stripComment(raw);
    const text = stripped.trim();
    if (text === "" || text === "---" || text === "...") continue;
    const indent = stripped.length - stripped.trimStart().length;
    out.push({ indent, text });
  }
  return out;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function isSeqLine(line: Line): boolean {
  return line.text === "-" || line.text.startsWith("- ");
}

function isMappingEntry(text: string): boolean {
  return text.endsWith(":") || findKeySeparator(text) !== -1;
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  return isSeqLine(lines[start])
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const arr: YamlValue[] = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && isSeqLine(lines[i])) {
    const rest = lines[i].text === "-" ? "" : lines[i].text.slice(2).trim();
    i++;
    if (rest === "") {
      if (i >= lines.length || lines[i].indent <= indent) {
        arr.push(null);
        continue;
      }
      const [val, next] = parseBlock(lines, i, lines[i].indent);
      arr.push(val);
      i = next;
    } else if (isMappingEntry(rest)) {
      // Sequence of mappings ("- key: value" with sibling keys aligned to the
      // column after the dash), e.g. the N1.5 data_config.yaml datasets list.
      const childIndent = indent + 2;
      const sub: Line[] = [{ indent: childIndent, text: rest }];
      while (i < lines.length && lines[i].indent >= childIndent) {
        sub.push(lines[i]);
        i++;
      }
      const [val] = parseBlock(sub, 0, childIndent);
      arr.push(val);
    } else {
      arr.push(parseScalar(rest));
    }
  }
  return [arr, i];
}

function parseMapping(
  lines: Line[],
  start: number,
  indent: number,
): [{ [key: string]: YamlValue }, number] {
  const obj: { [key: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent && !isSeqLine(lines[i])) {
    const { key, value } = splitKey(lines[i].text);
    i++;
    if (value !== "") {
      obj[key] = parseScalar(value);
      continue;
    }
    if (i < lines.length && lines[i].indent > indent) {
      const [val, next] = parseBlock(lines, i, lines[i].indent);
      obj[key] = val;
      i = next;
    } else if (i < lines.length && lines[i].indent === indent && isSeqLine(lines[i])) {
      // Sequence indented at the mapping's own column (valid YAML).
      const [val, next] = parseSequence(lines, i, indent);
      obj[key] = val;
      i = next;
    } else {
      obj[key] = null;
    }
  }
  return [obj, i];
}

function splitKey(text: string): { key: string; value: string } {
  if (text.endsWith(":")) return { key: unquote(text.slice(0, -1).trim()), value: "" };
  const idx = findKeySeparator(text);
  if (idx === -1) throw new Error(`not a mapping entry: ${text}`);
  return { key: unquote(text.slice(0, idx).trim()), value: text.slice(idx + 1).trim() };
}

function findKeySeparator(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ":" && !inSingle && !inDouble && (i + 1 >= text.length || text[i + 1] === " ")) {
      return i;
    }
  }
  return -1;
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s === "") return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner === "" ? [] : splitFlow(inner).map((item) => parseScalar(item));
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    const obj: { [key: string]: YamlValue } = {};
    if (inner === "") return obj;
    for (const part of splitFlow(inner)) {
      const { key, value } = splitKey(part.trim());
      obj[key] = parseScalar(value);
    }
    return obj;
  }
  if (s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  return s;
}

function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = "";
  for (const c of inner) {
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble && (c === "[" || c === "{")) depth++;
    else if (!inSingle && !inDouble && (c === "]" || c === "}")) depth--;
    else if (c === "," && depth === 0 && !inSingle && !inDouble) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}
