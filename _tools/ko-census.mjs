#!/usr/bin/env node
// THE CENSUS OF WHAT THE CODE DECIDES SILENTLY, AND OF WHAT NO ARM TOUCHES.
//
// Owner question 2026-11-20, verbatim: "e por que a gente continua sendo
// surpreendido pelo codigo inves de saber tudo que ta errado com ele? que
// ferramenta falta?"
//
// The measured answer is in this file. Every defect this project spent a wave
// on had the same shape: a guard that RETURNED without a row, or state that no
// arm ever exercised. A silent guard is invisible in the ring, so the only way
// to find it was to read the source - which is the surprise.
//
// This tool does not guess. It parses the shipped product files, finds every
// early exit (`return`/`continue`) that is a DECISION, and reports the ones with
// no log call of their own. It then cross-checks the declared state of the ad
// path against every suite, and names the fields no arm ever references.
//
// NOT every silent exit is a defect: a `return null` in a pure helper decides
// nothing the owner can see, and a guard whose refusal is logged by its CALLER
// is honest. That is why the tool separates "silent" from "silent AND
// guard-shaped" (the exit sits in a function that has log calls at all, i.e.
// the author knew the function must explain itself).
//
// Usage:
//   node _tools/ko-census.mjs            human report
//   node _tools/ko-census.mjs --json     machine report
//   node _tools/ko-census.mjs --gate     exit 1 when the count grows past
//                                        _tools/ko-census-budget.json
import fs from 'node:fs';
import path from 'node:path';

// KO_CENSUS_ROOT exists so the gate can be proved to FAIL without mutating a
// product file that a live lane owns: the falsifier copies the tree, plants a
// silent guard there, and this tool must name it.
const ROOT = process.env.KO_CENSUS_ROOT
  ? path.resolve(process.env.KO_CENSUS_ROOT)
  : path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PRODUCT = ['kick-overlay/content.js', 'kick-overlay/twitch-adblock.js', 'kick-overlay/player-bridge.js'];
const SUITES = [
  'kick-overlay/ad-time-continuity-test.cjs',
  'kick-overlay/ad-detect-test.cjs',
  'kick-overlay/mute-decision-test.cjs',
  'kick-overlay/content-fix-test.cjs',
  'kick-overlay/cold-cover-fixture-test.cjs',
  'kick-overlay/tab-audio-scope-test.cjs',
  'kick-overlay/yt-route-test.cjs',
];
const LOG = /\b(diag|adLog|adLogState|console\.(log|debug|warn|error))\s*\(/;

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

// Which function each line belongs to, without a full JS parser: track the last
// `function name(` / `const name = (` opening at column 0-2 and its brace depth.
function functionIndex(lines) {
  const owner = new Array(lines.length).fill(null);
  let current = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(?:  )?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:  )?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(line);
    if (m && depth <= 2) current = m[1] || m[2];
    owner[i] = current;
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    if (depth === 0) current = null;
  }
  return owner;
}

// Blank out comments and string literals so a `return` inside either is never a
// decision, and preserve offsets so line numbers stay exact.
function maskNonCode(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length).replace(/[^\n]/g, ' '));
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  out = out.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
  return out;
}

function censusFile(rel) {
  const src = read(rel);
  if (!src) return null;
  const lines = src.split('\n');
  const masked = maskNonCode(src);
  const maskedLines = masked.split('\n');
  const owner = functionIndex(maskedLines);
  const logsByFn = new Map();
  for (let i = 0; i < maskedLines.length; i++) {
    const fn = owner[i];
    if (!fn) continue;
    if (LOG.test(maskedLines[i])) logsByFn.set(fn, (logsByFn.get(fn) || 0) + 1);
  }
  // Column offsets -> line numbers, computed once.
  const starts = [];
  let at = 0;
  for (const l of maskedLines) {
    starts.push(at);
    at += l.length + 1;
  }
  const lineOf = (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const exits = [];
  // `if (x) return;` on ONE line is the most common guard form in this tree and
  // a line-start matcher missed every one of them. Measured 2026-11-20: the
  // planted silent guard (`if (overlay.standby && !overlay.revealed) return;`)
  // was invisible until this scan moved to token offsets.
  for (const m of masked.matchAll(/\b(return|continue)\b/g)) {
    const idx = lineOf(m.index);
    const fn = owner[idx];
    if (!fn) continue;
    // Exclude the `return` of a one-line arrow callback that is not a guard
    // (`map(x => { return y; })` still is one, so only bare expression bodies
    // are dropped, and those never reach this regex).
    const near = maskedLines.slice(Math.max(0, idx - 3), idx + 2).some((l) => LOG.test(l));
    const fnLogs = logsByFn.get(fn) || 0;
    exits.push({
      line: idx + 1,
      fn,
      text: lines[idx].trim().slice(0, 90),
      loggedNearby: near,
      guardShaped: fnLogs > 0 && !near,
    });
  }
  return {
    file: rel,
    functions: new Set(owner.filter(Boolean)).size,
    exits,
    silent: exits.filter((e) => !e.loggedNearby),
    guardShaped: exits.filter((e) => e.guardShaped),
  };
}

// State fields declared on the ad path's own object, and whether ANY suite
// references them. A field no arm references is a field whose behaviour only
// the owner can discover.
function stateCensus() {
  const src = read('kick-overlay/twitch-adblock.js');
  if (!src) return null;
  const start = src.indexOf('const overlay = {');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(open + 1, end).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const fields = new Set();
  for (const m of body.matchAll(/(?:^|,|\n)\s*([A-Za-z_$][\w$]*)\s*:/g)) fields.add(m[1]);
  const suites = SUITES.map(read).filter(Boolean).join('\n');
  const referenced = new Set([...fields].filter((f) => new RegExp(`\\.${f}\\b`).test(suites)));
  return {
    declared: fields.size,
    referenced: referenced.size,
    unexercised: [...fields].filter((f) => !referenced.has(f)).sort(),
  };
}

const json = process.argv.includes('--json');
const gate = process.argv.includes('--gate');

const files = PRODUCT.map(censusFile).filter(Boolean);
const state = stateCensus();
const totals = files.reduce(
  (a, f) => ({ exits: a.exits + f.exits.length, silent: a.silent + f.silent.length, guardShaped: a.guardShaped + f.guardShaped.length }),
  { exits: 0, silent: 0, guardShaped: 0 },
);
const out = { files, totals, state };

if (json) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

console.log('SILENT DECISIONS (an exit that returns with no row of its own)\n');
for (const f of files) {
  console.log(`${f.file}  functions=${f.functions}  exits=${f.exits.length}  silent=${f.silent.length}  guard-shaped=${f.guardShaped.length}`);
  for (const e of f.guardShaped.slice(0, 25)) {
    console.log(`  :${e.line}  ${e.fn}  ${e.text}`);
  }
  if (f.guardShaped.length > 25) console.log(`  ... ${f.guardShaped.length - 25} more`);
  console.log('');
}
console.log(`TOTAL exits=${totals.exits} silent=${totals.silent} guard-shaped-silent=${totals.guardShaped}`);
console.log('A guard-shaped silent exit is the class every surprise came from: the ring cannot');
console.log('say it happened, so the only way to find it was to read the source.\n');

if (state) {
  console.log(`AD-PATH STATE: declared=${state.declared} referenced-by-an-arm=${state.referenced} unexercised=${state.unexercised.length}`);
  console.log(`  ${state.unexercised.join(', ')}\n`);
}

if (gate) {
  const budgetPath = path.join(ROOT, '_tools/ko-census-budget.json');
  let budget = null;
  try {
    budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
  } catch {
    console.error(`NO BUDGET at ${budgetPath}: write it with the measured counts before this gate can pass.`);
    process.exit(1);
  }
  const problems = [];
  for (const f of files) {
    const cap = budget.guardShaped && budget.guardShaped[f.file];
    if (cap == null) {
      problems.push(`${f.file}: no budget entry (add its measured guard-shaped count)`);
    } else if (f.guardShaped.length > cap) {
      problems.push(`${f.file}: guard-shaped silent=${f.guardShaped.length} > budget ${cap}`);
    }
  }
  if (budget.unexercisedState != null && state && state.unexercised.length > budget.unexercisedState) {
    problems.push(`unexercised ad-path state=${state.unexercised.length} > budget ${budget.unexercisedState}`);
  }
  if (problems.length) {
    console.error('RESULT FAIL');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`RESULT PASS  guardShaped=${totals.guardShaped}  unexercisedState=${state ? state.unexercised.length : 'n/a'}  (budget met)`);
}
