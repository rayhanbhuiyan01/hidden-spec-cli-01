// main.ts is mend, the CLI SPEC.md specifies (MIT). It applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of files,
// all or nothing. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The first defined value, or null when none is defined. */
function pick<T>(...vs: Array<T | undefined>): T | null {
  for (const v of vs) if (v !== undefined) return v;
  return null;
}

/** A file's lines under its own line break (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function trimRightWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimBothWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Line matching at one tier (SPEC.md section 5). */
function matchLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRightWs(a) === trimRightWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function findOccurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!matchLine(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions, or null. */
function findTier(lines: string[], O: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(lines, O, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/**
 * The lines N becomes in the file: a context line is the file's own matched line, never the patch's;
 * at tier 2 every other line is re-indented from O's first line to the file's first matched line.
 * nCtx[j] is the index in O of N's j-th line when it is a context line, else -1.
 */
function buildReplacement(N: string[], nCtx: number[], O: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) {
    return N.map((l, j) => (nCtx[j]! >= 0 ? fileLines[pos + nCtx[j]!]! : l));
  }
  const F = leadingWs(fileLines[pos]!);
  const P = leadingWs(O[0]!);
  return N.map((l, j) => {
    if (nCtx[j]! >= 0) return fileLines[pos + nCtx[j]!]!;
    if (l === '' || /^[ \t]*$/.test(l)) return l;
    if (l.startsWith(P)) return F + l.slice(P.length);
    return l;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface HunkItem {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  items: HunkItem[];
}

interface UniSection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  plusNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function makeHunkItem(L: string): HunkItem {
  if (L === '') return { kind: 'ctx', text: '', raw: L };
  const c = L[0]!;
  if (c === ' ') return { kind: 'ctx', text: L.slice(1), raw: L };
  if (c === '-') return { kind: 'del', text: L.slice(1), raw: L };
  if (c === '+') return { kind: 'add', text: L.slice(1), raw: L };
  return { kind: 'bs', text: L.slice(1), raw: L };
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed; /dev/null is null. */
function uniPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Split a hunk's body into O and N, with N's context lines mapped to their index in O. */
function hunkON(h: Hunk): { O: string[]; N: string[]; nCtx: number[] } {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: number[] = [];
  for (const it of h.items) {
    if (it.kind === 'ctx') {
      nCtx.push(O.length);
      O.push(it.text);
      N.push(it.text);
    } else if (it.kind === 'del') {
      O.push(it.text);
    } else if (it.kind === 'add') {
      nCtx.push(-1);
      N.push(it.text);
    }
  }
  return { O, N, nCtx };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  for (let k = h.items.length - 1; k >= 0; k--) {
    const it = h.items[k]!;
    if (it.kind === 'ctx' || it.kind === 'add') {
      return k + 1 < h.items.length && h.items[k + 1]!.kind === 'bs';
    }
  }
  return false;
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const sf = splitFile(text);
  const cur = [...sf.lines];
  let curFinal = sf.final;
  let d = 0;
  for (const h of hunks) {
    const { O, N, nCtx } = hunkON(h);
    const noEol = hunkNoEol(h);
    if (O.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), cur.length);
      const atEnd = idx === cur.length;
      cur.splice(idx, 0, ...N);
      if (atEnd) curFinal = !noEol;
    } else {
      const found = findTier(cur, O, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      const matchedToEnd = pos + O.length === cur.length;
      const repl = buildReplacement(N, nCtx, O, cur, pos, found.tier);
      cur.splice(pos, O.length, ...repl);
      if (matchedToEnd) curFinal = !noEol;
    }
    d += N.length - O.length;
  }
  return joinFile(cur, sf.br, curFinal);
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  const oldPath = pick(sec.pairOld, sec.renameFrom, sec.diffOld);
  const newPath = pick(sec.pairNew, sec.renameTo, sec.plusNew, sec.diffNew);
  const isCreate = sec.isCreate || oldPath === null;
  const isDelete = !isCreate && (sec.isDelete || newPath === null);
  return (tree) => {
    if (isCreate && newPath === null) return;
    if (isCreate) {
      const np = newPath as string;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const it of h.items) if (it.kind === 'add') plus.push(it.text);
      }
      let noEol = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        let lastAdd = -1;
        for (let k = 0; k < h.items.length; k++) if (h.items[k]!.kind === 'add') lastAdd = k;
        if (lastAdd >= 0) {
          noEol = lastAdd + 1 < h.items.length && h.items[lastAdd + 1]!.kind === 'bs';
          break;
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldPath as string;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldPath !== newPath) {
      const op = oldPath as string;
      const np = newPath as string;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const text = tree.get(op);
      if (text === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(text, sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.moves.push([op, np]);
      return;
    }
    const p = oldPath as string;
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(text, sec.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const fresh = (): UniSection => ({
    diffOld: undefined,
    diffNew: undefined,
    pairOld: undefined,
    pairNew: undefined,
    plusNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  let cur: UniSection | null = null;
  let body: Hunk | null = null;
  const endBody = (): void => {
    if (body === null) return;
    while (body.items.length > 0 && body.items[body.items.length - 1]!.raw === '') body.items.pop();
    body = null;
  };
  const closeSection = (): void => {
    endBody();
    cur = null;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const L = lines[i]!;
    if (body !== null) {
      if (L.startsWith('diff --git ') || (L.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endBody();
      } else if (L === '' || L.startsWith(' ') || L.startsWith('-') || L.startsWith('+') || L.startsWith('\\')) {
        body.items.push(makeHunkItem(L));
        i++;
        continue;
      } else {
        endBody();
      }
    }
    if (L.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeSection();
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (L.startsWith('--- ')) {
      const nextPlus = (lines[i + 1] ?? '').startsWith('+++ ');
      if (nextPlus) {
        if (cur !== null && cur.pairOld === undefined && cur.hunks.length === 0) {
          cur.pairOld = uniPath(L);
          cur.pairNew = uniPath(lines[i + 1]!);
        } else {
          closeSection();
          cur = fresh();
          cur.pairOld = uniPath(L);
          cur.pairNew = uniPath(lines[i + 1]!);
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (L.startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && cur.plusNew === undefined) cur.plusNew = uniPath(L);
      i++;
      continue;
    }
    if (L.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h: Hunk = { a: parseInt(m[1]!, 10), items: [] };
      cur.hunks.push(h);
      body = h;
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (L.startsWith('rename from ')) cur.renameFrom = L.slice('rename from '.length).trim();
      else if (L.startsWith('rename to ')) cur.renameTo = L.slice('rename to '.length).trim();
      else if (L.startsWith('new file mode')) cur.isCreate = true;
      else if (L.startsWith('deleted file mode')) cur.isDelete = true;
    }
    i++;
  }
  endBody();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const sf = splitFile(text);
    const found = findTier(sf.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const nCtx = newLines.map(() => -1);
    const repl = buildReplacement(newLines, nCtx, oldLines, sf.lines, pos, found.tier);
    const cur = [...sf.lines];
    cur.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(cur, sf.br, sf.final));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  const n = lines.length;
  for (;;) {
    let s = -1;
    for (let k = prevEnd + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s === -1) break;
    let eq = -1;
    for (let k = s + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq !== -1) {
      for (let k = eq + 1; k < n; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq === -1 || rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  items: HunkItem[];
}

const V4A_SECTION = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;
const V4A_MOVE_TO = '*** Move to: ';

function v4aSectionEdit(
  kind: string,
  path: string,
  headerNo: number,
  content: Array<{ text: string; no: number }>,
  strict: boolean,
): Edit {
  if (kind === 'Add File') {
    const fileLines: string[] = [];
    for (const c of content) {
      if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
      else if (c.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${c.no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'Delete File') {
    if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.no}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (content.length > 0 && content[0]!.text.startsWith(V4A_MOVE_TO)) {
    moveTo = content[0]!.text.slice(V4A_MOVE_TO.length).trim();
    idx = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  for (; idx < content.length; idx++) {
    const c = content[idx]!;
    const t = c.text;
    if (t.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
    } else if (t === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${c.no}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${c.no}`);
        cur = { anchor: null, eof: false, items: [] };
      }
      cur.items.push(makeHunkItem(t));
    } else {
      throw new Exit2(`error: parse ${c.no}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const sf = splitFile(text);
    const curLines = [...sf.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = findTier(curLines, [ch.anchor], strict, cursor);
        if (a === null) throw new Fail('no-match', path);
        cursor = a.positions[0]! + 1;
      }
      const { O, N, nCtx } = hunkON({ a: 0, items: ch.items });
      if (O.length === 0) {
        const ins = ch.eof ? curLines.length : cursor;
        curLines.splice(ins, 0, ...N);
        cursor = ins + N.length;
      } else {
        const found = findTier(curLines, O, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos: number;
        if (ch.eof) {
          const atEnd = found.positions.find((p) => p + O.length === curLines.length);
          if (atEnd === undefined) throw new Fail('no-match', path);
          pos = atEnd;
        } else {
          pos = found.positions[0]!;
        }
        const repl = buildReplacement(N, nCtx, O, curLines, pos, found.tier);
        curLines.splice(pos, O.length, ...repl);
        cursor = pos + N.length;
      }
    }
    const out = joinFile(curLines, sf.br, sf.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const L = lines[i]!;
    if (blank(L)) {
      i++;
      continue;
    }
    const m = V4A_SECTION.exec(L);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const headerNo = i + 1;
    i++;
    const content: Array<{ text: string; no: number }> = [];
    while (i < last) {
      const L2 = lines[i]!;
      if (L2.startsWith('*** Add File: ') || L2.startsWith('*** Delete File: ') || L2.startsWith('*** Update File: ')) break;
      content.push({ text: L2, no: i + 1 });
      i++;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    edits.push(v4aSectionEdit(kind, path, headerNo, content, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      rOld.add(oldP);
      rNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
