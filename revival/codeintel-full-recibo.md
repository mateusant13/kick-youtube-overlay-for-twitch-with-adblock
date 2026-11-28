# codeintel full receipt — kicktwitch

## Tracked pin

Command: `grep -n -i 'project-revival' 'G:/Temp/wt/RolloutKick-20261127/AGENTS.md'`

Output line:

```text
95:- **Pinned skill version: `project-revival` v4.6.0** (`C:/Users/Administrador/.agents/skills/project-revival/SKILL.md` declares `version: "4.6.0"`, measured 2026-11-27). This project's gate is `py -3 scripts/gate.py`; its matrix is `harness/angulos.tsv` (the file the fleet's `angulos` vocabulary names).
```

## Worktree and HEAD

Command: `git -C 'G:/Temp/wt/RolloutKick-20261127' rev-parse HEAD`

Output: `1e87c897a24627d5d3d1cbffbe91a353bd612cfe`

Branch: `lane/RolloutKickFull-20261127`. Worktree: `G:/Temp/wt/RolloutKick-20261127`.

## Repo gate (run once)

Command: `'H:/Python311/python.exe' -m watcher run --cpu 4 --cwd 'G:/Temp/wt/RolloutKick-20261127' --single RolloutKickGate --io very-low --timeout 300 -- 'H:/Python311/python.exe' scripts/gate.py`

rc: `0` (`GATE_RC=0`). Wrapper wall line: `child exit code 0 — total 77.5s (startup 0.6s, wait 76.6s, not-scheduled 0.0s, wrapper cpu 0.92s, launched pid cpu 0.88s [that pid only; not its descendants])`.

Stage lines, verbatim from `G:/Temp/revival-artifacts/RolloutKick/gate.out`:

```text
PASS syntax_background 0.20s rc=0
PASS syntax_content 0.23s rc=0
PASS syntax_twitch-adblock 0.21s rc=0
PASS syntax_player-bridge 0.21s rc=0
PASS syntax_adblock-bridge 0.21s rc=0
PASS syntax_popup 0.16s rc=0
PASS census_gate 0.87s TOTAL exits=457 silent=325 guard-shaped-silent=4 | A guard-shaped silent exit is the class every surprise came from: the ring cannot | say it happened, so the only way to find it was to read the source. | AD-PATH STATE: declared=68 referenced-by-an-arm=44 unexercised=24 | adoptTimer, audioAgreedAt, audioSent, autoplayRetry, coldCover, coldTimer, extTimer, hiddenVideos, hideTimer, lastEndAt, layoutSaved, nativeHidden, nativeLat, positionTimer, rewound, smallRectSince, stallTimer, switchPrev, swit
PASS bridge_handshake 0.26s PASS RED item 1: without the clear, the next heartbeat drags back to the load offset | PASS item 4: a sentinel seekable end never moves the playhead | PASS item 4: the refusal row prints the sentinel and its limit | PASS RED item 4: restoring the pre-fix guard derives 1073741821 | ANTI-VACUITY suite=bridge-handshake checks=30 expected=30 | RESULT PASS bridge-handshake checks=30 failed=0
PASS content_fix 6.92s [ko] kick reconnect attempt 1/3 | item 15 reconnect backoff: a route change stops the recovery - OK | item 16 cold hold: only product-written signals count - OK | ARMS 57/57 present | RESULT PASS content-fix checks=57 failed=0 | ALL CONTENT.JS FIX CHECKS PASSED
PASS selftest_adlog-verdict 1.23s ok   arm3: no playlist and no hook keeps NONE | ok   arm3: NONE still says the proof is missing | arm  4-rc | ok   arm4: EVICTED is not a defect - exit 0 | ok   arm4: the silent load still exits 1 (the arm can fail the other way) | RESULT PASS adlog-verdict checks=8 failed=0 arms=4/4
PASS selftest_crash-receipt 0.23s ok   with the guard the stale PASS is replaced by FAIL | arm  normal path intact | ok   finalizeReceipt still writes PASS when no check failed | ok   the happy path keeps its check rows | ARMS 3/3 present | RESULT PASS crash-receipt checks=12 failed=0
PASS selftest_guest-load-guard 0.99s ok   ready: launches | ok   ready: no refusal text | arm  4-flag | ok   flag: the URL is not a --flag | ok   flag: default port stays 9446 (never 9333, the relay) | RESULT PASS guest-load-guard checks=15 failed=0 arms=4/4
PASS selftest_harness-tools 8.70s ok   plant: the replayed journal is deleted | arm  17-red-preexisting-journal-ignored | ok   red: the pre-fix plant never replays the orphaned journal | ok   red: the mutant stays on disk | ok   red: the journal stays unread | RESULT PASS harness-tools checks=62 failed=0 arms=17/17
PASS selftest_heavy-lock 3.42s - OK a dead holder is stolen from | - OK the steal is reported, not silent | ARM release | - OK a fresh name is taken | - OK after release the name is free again | RESULT PASS heavy-lock checks=10 failed=0 arms=4/4
PASS selftest_ledger-invariant 0.24s arm  state-only | ok   verified:false makes no claim | ok   state verified still carries a binding | ok   the other direction of the hole is refused too | ARMS 4/4 present | RESULT PASS ledger-invariant checks=15 failed=0
PASS selftest_timed-suite 1.65s ok   failing suite: rc propagated (7) | ok   failing suite: prints RESULT FAIL with the rc | arm  5-mutant | ok   MUTANT: ceilings raised, the busy box measures (so the refusal arms can fail the other way) | ok   MUTANT: no refusal when the instrument was told nothing is busy | RESULT PASS timed-suite checks=14 failed=0 arms=5/5
PASS sim 3.27s ceiling=cpu=3000 io=very-low subprocess-timeout=120s wrapper-timeout=150s run.py: cap de CPU aplicado no filho pid=72732 rate=30% kernel=3000 | run.py: io prioridade aplicada no filho pid=72732 nivel=very-low (0) | [SIM-GATE] PASS rows=41 problems=0 graduated=0 attempts=48 failed_preserved=4 changed=0 sim_updated=False | RUN rc=0 log=state\logs\run-gate-sim-20261127T222359.log dur=3.0s
PASS feature_map 3.45s ceiling=cpu=3000 io=very-low subprocess-timeout=180s wrapper-timeout=210s run.py: io prioridade aplicada no filho pid=18456 nivel=very-low (0) | { | "verdict": "PASS", | "problems": [] | } | RUN rc=0 log=state\logs\run-gate-feature_map-20261127T222402.log dur=3.2s
PASS failfast 1.77s ceiling=cpu=3000 io=very-low subprocess-timeout=180s wrapper-timeout=210s "max_files": 20000, | "max_findings_out": 4000, | "findings": [], | "verdict": "PASS" | } | RUN rc=0 log=state\logs\run-gate-failfast-20261127T222405.log dur=1.6s
PASS angles 42.24s ceiling=row-timeout<=60s stage-ceiling=180s gate-timeout=210s ANGLES PASS rows=15 holes=0 rc=0 ceiling=180s row-timeout<=60s wall_s=42.05
CANNOT-MEASURE pytest 0.00s ceiling=none (in-process file count; no child launched, stage budget=30s) NO PYTEST SUITE: 0 file(s) matching test_*.py / *_test.py; absent: tests/, pytest.ini, pyproject.toml, setup.cfg, tox.ini, conftest.py
CANNOT-MEASURE health_changed 0.00s ceiling=none (no command configured; no child launched; tier=t1_s) skipped: not-configured (empty gate.toml slot; tier=t1_s)
CANNOT-MEASURE health_blast_radius 0.00s ceiling=none (no command configured; no child launched; tier=t1_s) skipped: not-configured (empty gate.toml slot; tier=t1_s)
CANNOT-MEASURE changed_context 0.00s ceiling=none (no command configured; no child launched; tier=t1_s) skipped: not-configured (empty gate.toml slot; tier=t1_s)
CANNOT-MEASURE verify_names 0.00s ceiling=none (no command configured; no child launched; tier=t1_s) skipped: not-configured (empty gate.toml slot; tier=t1_s)
CANNOT-MEASURE test_impacted 0.00s ceiling=none (no command configured; no child launched; tier=t1_s) skipped: not-configured (empty gate.toml slot; tier=t1_s)
CANNOT-MEASURE artifact_gate 0.00s ceiling=none (no command configured; no child launched; tier=t2_s) skipped: not-configured (empty gate.toml slot; tier=t2_s)
CANNOT-MEASURE smoke_paired 0.00s ceiling=none (no command configured; no child launched; tier=t2_s) skipped: not-configured (empty gate.toml slot; tier=t2_s)
CANNOT-MEASURE audit_anticheat 0.00s ceiling=none (no command configured; no child launched; tier=t2_s) skipped: not-configured (empty gate.toml slot; tier=t2_s)
NOT-RUN artifact_caps: external census from AGENTS.md:89; opt-in, walks G:/Temp
NOT-RUN ko_verify: the project's one heavy gate (AGENTS.md:469); run alone under watcher
RESULT PASS stages=29 failed=0 cannot_measure=0 informational_cannot=9
```

## codeintel full

Exact command (argv the wrapper launched, from `G:/Temp/revival-artifacts/RolloutKick/full.wrap.out`):

```text
H:/Python311/python.exe -m codeintel full --json --scope _tools,kick-overlay,scripts --stream G:/Temp/revival-artifacts/RolloutKick/full.stream.jsonl .
```

Wrapper command: `'H:/Python311/python.exe' -m watcher run --cpu 4 --cwd 'G:/Temp/wt/RolloutKick-20261127' --single RolloutKickFull --io very-low --timeout 600 -- 'H:/Python311/python.exe' -m codeintel full --json --scope _tools,kick-overlay,scripts --stream 'G:/Temp/revival-artifacts/RolloutKick/full.stream.jsonl' .`

The real CLI is `python -m codeintel full [OPTIONS] [REPO]`: the repository is positional, there is no `--repo` flag; `--scope` resolves comma-separated directories.

Wrapper ceiling: `600 s`. Wall: `8.2 s` (`child exit code 1 — total 8.2s (startup 0.7s, wait 7.5s, not-scheduled 0.0s, wrapper cpu 0.47s, launched pid cpu 4.34s [that pid only; not its descendants])`); bash wall `8 s` (`BASH_WALL=8`).

rc: `1` (`FULL_RC=1`). Document verdict: `fail`; `exit_code=1`; `complete=true`; `refusal=null`.

Detector counts: `measured=18`, `refused=0`, `total=18` (`detectors.refused=[]`, `detectors_pending=[]`).

Ranked findings: `7` (`findings_total=7`); by class:

```text
SUBPROCESS-NO-CONSOLE: 1
SUPPRESS-BROAD-EXCEPT: 1
TYPED-FIELD-GUARD: 1
ENV-VAR-WITHOUT-PRODUCER: 1
WIRED-READ-UNWIRED: 1
ABSOLUTE-DEFAULT-PATH: 1
SILENT-TRUNCATION: 1
```

By severity: `high=3`, `medium=2`, `info=2`. Producer `summary` counts all rows including outside-scope/suppressed aggregates: `ABSOLUTE-DEFAULT-PATH=1 AMBIGUOUS-PROVENANCE=41 DEAD-CONFIG-KEY=41 ENV-VAR-WITHOUT-PRODUCER=1 INERT-GRADUATION=26 NEAR-DUPLICATE-CAUSE=7 PASS=2 RUNG-LAG=6 SELECTOR-MATCHES-NOTHING=5 SILENT-TRUNCATION=1 STALE-UNRESOLVED=41 SUBPROCESS-NO-CONSOLE=1 SUPPRESS-BROAD-EXCEPT=1 TYPED-FIELD-GUARD=1 UNORDERED-CAP-SLICE=5 VIOLATION=1 WIRED-READ-UNWIRED=1 total=7 cannot_measure=0 detectors_measured=18`.

CANNOT-MEASURE classes named by `codeintel full`: none — `cannot_measure=0`, `cannot_measure_rows=[]`, `detectors.refused=[]`. The gate's nine informational `CANNOT-MEASURE` rows are gate stages, not full-detector refusals: `pytest`, `health_changed`, `health_blast_radius`, `changed_context`, `verify_names`, `test_impacted`, `artifact_gate`, `smoke_paired`, `audit_anticheat`.

Every refusal, verbatim: no refusal was emitted. The document has `refusal=null`; the wrapper output has no `full:` refusal line. Wrapper line: `child exit code 1 — total 8.2s (startup 0.7s, wait 7.5s, not-scheduled 0.0s, wrapper cpu 0.47s, launched pid cpu 4.34s [that pid only; not its descendants])`.

Counts parsed with: `'H:/Python311/python.exe' -c "import json,collections,pathlib;d=json.loads(pathlib.Path('G:/Temp/revival-artifacts/RolloutKick/full.stream.jsonl').read_text(encoding='utf-8'));print('verdict',d['verdict'],'rc',d['exit_code'],'measured',d['measured'],'refused',len(d['detectors']['refused']),'total',d['total'],'cannot_measure',d['cannot_measure'],'findings',len(d['findings']));print('by_class',dict(collections.Counter(x['class'] for x in d['findings'])));print('cannot_measure_rows',d['cannot_measure_rows'],'refusal',d['refusal'])"`

Output: `verdict fail rc 1 measured 18 refused 0 total 18 cannot_measure 0 findings 7` / `by_class {'SUBPROCESS-NO-CONSOLE': 1, 'SUPPRESS-BROAD-EXCEPT': 1, 'TYPED-FIELD-GUARD': 1, 'ENV-VAR-WITHOUT-PRODUCER': 1, 'WIRED-READ-UNWIRED': 1, 'ABSOLUTE-DEFAULT-PATH': 1, 'SILENT-TRUNCATION': 1}` / `cannot_measure_rows [] refusal None`.

## Scorer

Command: `'H:/Python311/python.exe' 'H:/codeintel-worktrees/triad-milestones-20261105/benchmarks/full_audit/score.py' --findings 'G:/Temp/revival-artifacts/RolloutKick/full.stream.jsonl'`

Output: `score.py: error: the following arguments are required: --truth`; rc `2` (`SCORER_RC=2`). No ground-truth file for this repository exists in either tree; no score was produced.

## Verdict

`FAIL (full rc=1): 18/18 detectors measured, 0 CANNOT-MEASURE classes, 7 ranked findings (3 high); the repo gate passed rc=0 and codeintel full emitted no refusal.`

## The build that produced this verdict (added 2026-11-28)

A verdict is only comparable with the codeintel build that emitted it: the detector set lives in the
installed tree (`H:\codeintel-worktrees\triad-milestones-20261105`), not in this repo. This file was
written without that line, so its `18/18` / `cannot_measure=0` is **CANNOT-COMPARE** against today's
install, which `py -3 -m codeintel --version` reports as
`codeintel 14.0.0 root=H:\codeintel-worktrees\triad-milestones-20261105 sha=d552474de514 branch=mission/consolidated-20261105`
with 25 detectors and, on the same scope, `verdict=partial` / `cannot_measure=259`. Read
`docs/A11-CODEINTEL-RECEIPT.md` §1 for the build-pinned run; treat the numbers above as the older
build's, still valid as history and not as the current tool's opinion.
