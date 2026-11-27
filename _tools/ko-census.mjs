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
// `function name(` / `const name = (…) =>` opening and its brace depth.
// A `const name = (` that is NOT an arrow function is an ordinary initializer
// (`const nat = (KO.nat = KO.nat || {...});`) and naming it as a function made
// every exit of the enclosing function report the wrong owner — measured
// 2026-11-20, `nativeStallWatch` showed 0 exits while `nat` showed 16.
function functionIndex(lines) {
  const owner = new Array(lines.length).fill(null);
  let current = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const decl = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
    const arrow = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/.exec(line);
    const arrow1 = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/.exec(line);
    const named = decl || arrow || arrow1;
    if (named && depth <= 2) current = named[1];
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
// decision. EVERY consumed character is replaced one-for-one and NEWLINES ARE
// PRESERVED: a multi-line block comment collapsed to spaces shifts every offset
// after it, and the census then names the wrong line (measured 2026-11-20: a
// `let lat = null;` was reported as a guard in `dispSample`).
const blank = (m) => m.replace(/[^\n]/g, ' ');
function maskNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, blank);
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
  // A LOGGING HELPER MAKES ITS CALLER HONEST. `return nativeStallRefuse('user-paused',
  // …)` writes a row inside the helper, so the exit is explained even though no
  // `diag(` sits on that line. Counting functions that log ANYWHERE in the file
  // (not only in this one) is what separates a real silence from a helper call:
  // without this, `nativeStallWatch` — the one function in the tree written to
  // the rule, 18 exits and every refusal named — read as 15 silent guards.
  // The helper relation is TRANSITIVE: measured 2026-11-27, `dispSample` refused
  // through `nativeStallHiddenRefuse()` (a helper whose only job is to write the
  // row through `nativeStallRefuse()`), so the exit sat on a line of its own with
  // a logging call one indirection away and read as silent. A function is a
  // helper when it logs itself or when its body hands control to a helper; the
  // fixpoint is bounded by the number of functions in the file.
  const calls = new Map();
  for (let i = 0; i < maskedLines.length; i++) {
    const fn = owner[i];
    if (!fn) continue;
    if (!calls.has(fn)) calls.set(fn, new Set());
    for (const m of maskedLines[i].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (m[1] !== fn) calls.get(fn).add(m[1]);
    }
  }
  const helpers = new Set();
  for (const [fn, n] of logsByFn) if (n > 0) helpers.add(fn);
  for (let round = 0; round < 8; round++) {
    let grew = false;
    for (const [fn, callees] of calls) {
      if (helpers.has(fn)) continue;
      for (const c of callees) if (helpers.has(c)) { helpers.add(fn); grew = true; break; }
    }
    if (!grew) break;
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
    if (!fn || fn === 'refuseValue' || fn === 'adLog') continue;
    const text = lines[idx] || '';
    // A `return` that hands control to a logging helper is explained by it.
    const callsHelper = [...helpers].some((h) => h !== fn && new RegExp(`\\b${h}\\s*\\(`).test(text));
    // The window is the exit and the STATEMENT that leads to it. A log call is a
    // multi-line object literal here, so a 3-line window missed the row that was
    // written twelve lines above the `return` it explains (measured 2026-11-27:
    // `nativeStallWatch`, `catchUpClean` and `stopAdOverlay` all read as silent
    // with their own row sitting inside the same statement). The walk stops at a
    // blank line or at the opening of a new block, so it explains the enclosing
    // branch and nothing further up.
    let back = idx;
    for (let k = idx - 1; k >= 0 && idx - k <= 14; k--) {
      const prev = maskedLines[k] || '';
      if (!prev.trim()) break;
      back = k;
      const hit = LOG.test(prev) || [...helpers].some((h) => new RegExp(`\\b${h}\\s*\\(`).test(prev));
      if (hit) break;
    }
    const window = maskedLines.slice(back, idx + 2).join('\n');
    const near = LOG.test(window) || [...helpers].some((h) => h !== fn && new RegExp(`\\b${h}\\s*\\(`).test(window));
    const fnLogs = logsByFn.get(fn) || 0;
    // A VALUE-PRODUCTION exit is not a decision. `return new Promise(…)`,
    // `return { … }`, `return class … extends Native` and `return function …`
    // BUILD the thing the caller asked for; they do not choose between doing
    // and refusing something the user can see. Measured 2026-11-27: four of the
    // remaining 18 "guard-shaped" exits were exactly these, and converting one
    // into a refusal row would have been a lie in the ring.
    const buildsValue = /^return\s+(new\s|class\s|\{|\[|function\s|[-\d'"`])/.test(text.trim());
    exits.push({
      line: idx + 1,
      fn,
      text: text.trim().slice(0, 90),
      loggedNearby: near || callsHelper,
      guardShaped: fnLogs > 0 && !near && !callsHelper && !buildsValue,
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
  // `--budget-red N` lowers every cap by N so the gate MUST refuse. It is the
  // falsifier behind the budget's `red_arm_cmd`: a comparison that cannot fail
  // is a green light with no wire in it.
  const redArg = process.argv.indexOf('--budget-red');
  if (redArg !== -1) {
    const drop = Number(process.argv[redArg + 1] || 1);
    for (const key of Object.keys(budget.guardShaped || {})) {
      const cap = budget.guardShaped[key] || 0;
      // A cap already at zero is not lowered: `0 > -1` would report a refusal
      // for a file that has nothing to refuse, which reads as a passing arm.
      budget.guardShaped[key] = cap > 0 ? cap - drop : cap;
    }
    if (budget.unexercisedState != null) budget.unexercisedState -= drop;
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
