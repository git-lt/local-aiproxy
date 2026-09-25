import fs from "node:fs";
import path from "node:path";

const TABLE_RE = /^\s*\[/;
const ASSIGN_RE = /^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)(.*?)(\r?\n)?$/;

function rootRange(lines: string[]): number {
  const end = lines.findIndex((line) => TABLE_RE.test(line));
  return end === -1 ? lines.length : end;
}

function findRootKey(lines: string[], key: string): number {
  const end = rootRange(lines);
  const matches = [];
  for (let i = 0; i < end; i += 1) {
    const match = lines[i].match(ASSIGN_RE);
    if (match?.[2] === key) matches.push(i);
  }
  if (matches.length > 1) {
    throw new Error(`Duplicate root-level TOML key: ${key}`);
  }
  return matches[0] ?? -1;
}

export function readRootTomlString(source: string, key: string): string | undefined {
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];
  const index = findRootKey(lines, key);
  if (index < 0) return undefined;
  const match = lines[index].match(ASSIGN_RE);
  if (!match) return undefined;
  const raw = match[4].trim();
  const basic = raw.match(/^"(?:[^"\\]|\\.)*"/);
  if (basic) {
    try {
      return JSON.parse(basic[0]);
    } catch {
      return undefined;
    }
  }
  // TOML literal string：单引号内没有转义，内容原样返回。
  const literal = raw.match(/^'[^'\n]*'/);
  if (literal) return literal[0].slice(1, -1);
  return undefined;
}

export function atomicWrite(file: string, contents: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents, { mode });
  fs.renameSync(temp, file);
}
