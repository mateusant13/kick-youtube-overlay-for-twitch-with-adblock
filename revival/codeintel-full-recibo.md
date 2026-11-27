# Receipt — `codeintel full` on this repository

Measured 2026-11-27 on this machine, installer
`H:/codeintel-worktrees/triad-milestones-20261105` (syspath guard active, `repo(cwd)=H:\kicktwitchyoutube_instagram`).

## Command and output

```
cd H:/kicktwitchyoutube_instagram
py -3 -m codeintel full H:/kicktwitchyoutube_instagram --json --max-population-files 400
```

```
rc            = 1 (findings exist; every detector answered)
real          = 7.2 s
population_counts        = {"scope": 173, "outside-scope": 0, "scratch": 0}
population_class_counts  = {"product": 173, "docs": 0, "tests": 0, "benchmarks": 0, "unknown": 0}
findings                 = 173
detectors_completed      = 18      detectors_pending = []
complete                 = true    cannot_measure = 0
total (severity-weighted)= 18      verdict = fail
artifact_root            = H:\kicktwitchyoutube_instagram (containing worktree)
```

Detector mix (`summary` block):

| detector | findings |
|---|---:|
| DEAD-CONFIG-KEY | 48 |
| AMBIGUOUS-PROVENANCE | 37 |
| STALE-UNRESOLVED | 37 |
| INERT-GRADUATION | 24 |
| RUNG-LAG | 6 |
| NEAR-DUPLICATE-CAUSE | 4 |
| SELECTOR-MATCHES-NOTHING | 4 |
| UNORDERED-CAP-SLICE | 3 |
| VIOLATION | 1 |
| READER-WRITER-DRIFT | 1 |
| ENV-VAR-WITHOUT-PRODUCER | 1 |
| SILENT-TRUNCATION | 1 |
| SUBPROCESS-NO-CONSOLE | 1 |
| SUPPRESS-BROAD-EXCEPT | 1 |
| TYPED-FIELD-GUARD | 1 |
| WIRED-READ-UNWIRED | 1 |
| PASS | 2 |

## What the population number means, and the premise it refutes

The routed correction said the auditor is Python-only, so a repo with two `.py` files would report
`population_counts.scope = 0` for any `--scope`, and that is CANNOT-MEASURE rather than "0 findings".

Measured here, that premise is false for this repo: the classifier counted **173 product files**, and
all 18 detectors completed against them (`detectors_pending = []`, `cannot_measure = 0`). The two
`.py` files (`_tools/ko-bg-window.py`, `scripts/gate.py`) are the Python population, but the audited
population is not Python-only on this installer — it reads the JS/JSON product surface and the config
registries that produce DEAD-CONFIG-KEY / AMBIGUOUS-PROVENANCE / STALE-UNRESOLVED.

Where the premise does hold is `pytest`: `population_class_counts.tests = 0`. There is no pytest suite
to grade, so a `pytest` gate stage must print CANNOT-MEASURE naming that empty class, never "0 failures,
clean".

```text
population JS: 97 tracked .js/.mjs/.cjs/.ts files (113 when the working tree, not the index, is counted).
               The auditor DID cover 173 product files here, so this repo is measured, not blind.
               CANNOT-MEASURE applies to class `tests` (0 files): no pytest suite exists.
```

## Scorer

`benchmarks/full_audit/score.py` requires a truth artifact it does not have:

```
py -3 benchmarks/full_audit/score.py --findings <file> --expect-scope kick-overlay
score.py: error: the following arguments are required: --truth
```

No truth set exists (`fd -H ground_truth`, `fd -H FullAudit` -> nothing; `.agents/work/FullAudit`
absent). Grading the producer against a truth assembled from its own findings prints 100.0 for any
input, so recall / precision / outside_scope stay **CANNOT-MEASURE** for this repo.

## Revival rows in the project gate

`node _tools/ko-verify.mjs` -> `RESULT PASS checks=43 failed=0`, with the four revival rows registered
in `_tools/gate/checks/revival.mjs`:

| check | file:line | calls |
|---|---|---|
| `revival-features` | `_tools/gate/checks/revival.mjs:52` | `feature_map_sync.py --repo . --gate` |
| `revival-budgets` | `:67` | `benchmark_history.py` |
| `revival-friction` | `:96` | `loop_friction_audit.py measure --repo . --gate` |
| `revival-failfast` | `:128` | `fail_fast_audit.py scan --repo . --gate --all-code` |

## Reproduce

```
cd H:/kicktwitchyoutube_instagram
py -3 -m codeintel full H:/kicktwitchyoutube_instagram --json --max-population-files 400 \
  | jq -c '{verdict,total,population_counts,population_class_counts,detectors_completed:(.detectors_completed|length),cannot_measure}'
node _tools/ko-load-check.mjs --gate      # must print READY before the next line
node _tools/ko-verify.mjs                 # RESULT PASS checks=43 failed=0
```
