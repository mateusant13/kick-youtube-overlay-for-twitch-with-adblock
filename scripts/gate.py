#!/usr/bin/env python3
"""One command that runs this repo's real fast checks with named verdicts.

WHY: AGENTS.md:499 says "run the project gate before claiming done", but the
checkout had no `scripts/gate.py` and `revival/COMMANDS.md` only listed the
individual instruments. A lane could skip all of them by forgetting one line.

This driver runs the repo's own instruments, never a reimplementation: the JS
syntax check, `ko-census --gate`, the two product suites in `fast_test`, and the
gate's selftests. The minute-scale E2E gate (`node _tools/ko-verify.mjs`,
AGENTS.md:469) and the external artifact census are opt-in stages: AGENTS.md
requires exactly one heavy job at a time, so they are named, not silently run
beside the fast ones. `--stage <name>` runs one named stage, including opt-in.

Verdict rules (no silent green):

* `PASS` only when the child exits 0 AND its declared verdict text is present;
* `FAIL` with the stage name when a child or its verdict is red;
* `FAIL` (or `CANNOT-MEASURE`) when the child prints that verdict in
  assertion position but exits 0; a verdict word quoted inside an
  informational line is evidence, not a verdict.
* `CANNOT-MEASURE` when a tool/script is unavailable, a launch fails, or a
  stage exceeds its own explicit timeout -- printed as `SKIPPED: <reason>`
  for unavailable tools; never reported as `PASS`. On timeout the whole
  child tree is killed, so no grandchild outlives the gate's budget.

The four revival stages are registered here too: sim, feature_map, failfast and
pytest. The first three run under H:/!gravador/tools/run.py with an explicit
`--teto-cpu 3000 --io very-low` ceiling whenever that launcher exists; if it is
absent, the driver's own subprocess timeout is the printed ceiling. This repo
has no pytest suite, so pytest is always CANNOT-MEASURE, never a faked PASS.

`gate.toml` command slots are real stages: an empty slot prints
`skipped: not-configured`; a configured slot takes its timeout from [tiers],
and [tiers] is the single source of that number. Informational CANNOTs (empty
slots, absent pytest) do not fail a default run; selecting one with --stage
honours the driver's rc 3 CANNOT-MEASURE convention.
Exit codes: 0 all selected stages PASS, 2 any FAIL, 3 any CANNOT-MEASURE and
no FAIL. A FAIL outranks CANNOT-MEASURE so a red stays red.

Stdlib only. Every child is argv (no shell) with CREATE_NO_WINDOW on Windows
and a low thread count, so the gate cannot paint a console or hog the box.

Lane-local probes may be added through `_scratch/gate-extra.json` (gitignored):
  {"checks": [{"name": "probe", "argv": ["node", "-e", "process.exit(1)"],
               "timeout_s": 10, "pass_pattern": "RESULT PASS"}]}
A malformed overlay is a CANNOT-MEASURE stage, never a skipped check.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
try:
    import tomllib  # Python 3.11+ stdlib; absence is a declared refusal.
except ImportError:  # pragma: no cover - Python < 3.11
    tomllib = None  # type: ignore[assignment]

CREATE_NO_WINDOW = getattr(os, "CREATE_NO_WINDOW", 0x08000000)
PASS, FAIL, CANNOT = "PASS", "FAIL", "CANNOT-MEASURE"

# A verdict is a statement in assertion position, not an incidental word. Real
# passing children print "claim: SELFTEST PASS - quoted legacy FAIL message still
# caught" and "  ok  crashReceipt printed RESULT FAIL on its own stream": FAIL
# there is quoted evidence, not the child's verdict. Anchoring keeps those green
# while a child that actually prints FAIL/REFUSE under rc 0 stays red.
_NEG_VERDICT = re.compile(
    r"^\s*(?:(?:RESULT|[A-Za-z0-9_.@/-]+)\s*:\s*)*(FAIL|REFUSE|CANNOT-MEASURE)\b"
)


def _kill_tree(child: subprocess.Popen) -> None:
    """Kill the child and every descendant before re-reading captured pipes.

    On Windows ``subprocess.run(timeout=...)`` kills only the direct child and
    then re-reads its pipe with no deadline. A grandchild that inherited that
    pipe holds it open, so the gate blocks long past its own stage budget.
    """
    if os.name == "nt":
        try:
            subprocess.run(
                ("taskkill", "/PID", str(child.pid), "/T", "/F"),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW, timeout=5,
            )
            return
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        os.killpg(os.getpgid(child.pid), signal.SIGKILL)
    except (OSError, AttributeError):
        child.kill()
PRODUCT_JS = (
    "kick-overlay/background.js",
    "kick-overlay/content.js",
    "kick-overlay/twitch-adblock.js",
    "kick-overlay/player-bridge.js",
    "kick-overlay/adblock-bridge.js",
    "kick-overlay/popup.js",
)
SELFTESTS = (
    "adlog-verdict", "crash-receipt", "guest-load-guard", "harness-tools",
    "heavy-lock", "ledger-invariant", "timed-suite",
)
OVERLAY = Path("_scratch/gate-extra.json")
REVIVAL = Path("C:/Users/Administrador/.agents/skills/project-revival/scripts")
WRAPPER = Path("H:/!gravador/tools/run.py")
CEILING_CPU, CEILING_IO = "3000", "very-low"
GATE_TOML = "gate.toml"
DECLARED_SLOT_TIMEOUT = 90.0
COMMAND_TIER_DEFAULT = "t1_s"


@dataclass(frozen=True)
class Stage:
    name: str
    argv: tuple[str, ...]
    timeout_s: float
    pass_pattern: str | None = None
    heavy: bool = False
    note: str = ""
    ceiling: str = ""
    builtin: str = ""
    tier: str = ""
    declared_timeout_s: float | None = None
    optional_absent: bool = False


@dataclass(frozen=True)
class Result:
    name: str
    verdict: str
    detail: str
    wall_s: float
    child_rc: int | None = None
    timeout_s: float = 0.0
    skipped: bool = False
    ceiling: str = ""
    tier: str = ""
    informational: bool = False

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "verdict": self.verdict,
            "detail": self.detail,
            "wall_s": self.wall_s,
            "child_rc": self.child_rc,
            "timeout_s": self.timeout_s,
            "skipped": self.skipped,
            "ceiling": self.ceiling,
            "tier": self.tier,
            "informational": self.informational,
        }


def stages(repo: Path) -> list[Stage]:
    out = [
        Stage(f"syntax_{Path(rel).stem}", ("node", "--check", rel), 30.0,
              note="node --check on every shipped product file")
        for rel in PRODUCT_JS
    ]
    out += [
        Stage("census_gate", ("node", "_tools/ko-census.mjs", "--gate"), 90.0,
              r"RESULT PASS\s+guardShaped=\d+"),
        Stage("bridge_handshake", ("node", "kick-overlay/bridge-handshake-test.cjs"), 90.0,
              r"RESULT PASS bridge-handshake checks=\d+ failed=0"),
        Stage("content_fix", ("node", "kick-overlay/content-fix-test.cjs"), 120.0,
              r"ALL CONTENT\.JS FIX CHECKS PASSED"),
    ]
    out += [
        Stage(f"selftest_{name}", ("node", f"_tools/gate/{name}-selftest.mjs"), 90.0,
              r"RESULT PASS", note="negative arms of the gate's own instruments")
        for name in SELFTESTS
    ]
    revival_repo = str(repo)
    revival = (
        ("sim", (sys.executable, str(REVIVAL / "sim_memory.py"), "--repo", revival_repo,
                 "gate", "--no-require-update"), 120.0,
         r"\[SIM-GATE\] PASS rows=\d+ problems=0"),
        ("feature_map", (sys.executable, str(REVIVAL / "feature_map_sync.py"),
                         "--repo", revival_repo, "--gate"), 180.0,
         r'"verdict":\s*"PASS"'),
        ("failfast", (sys.executable, str(REVIVAL / "fail_fast_audit.py"), "scan",
                      "--repo", revival_repo, "--gate", "--all-code"), 180.0,
         r'"verdict":\s*"PASS"'),
    )
    for name, base, timeout, pattern in revival:
        argv, ceiling = _wrap_ceiling(name, base, timeout)
        out.append(Stage(name, argv, timeout, pattern, ceiling=ceiling,
                         note=f"Project Revival {name}; ceiling declared on the verdict line"))
    out.append(Stage("pytest", (), 30.0,
                     note="no pytest suite in this repo: typed CANNOT-MEASURE, never PASS",
                     ceiling="none (in-process file count; no child launched, stage budget=30s)",
                     builtin="pytest", optional_absent=True))
    out += [
        Stage("artifact_caps", (
            sys.executable, "I:/!watcher/tools/artifact-census.py", "--project", ".",
            "--own", "G:/Temp/ko-harness*", "--own", "G:/Temp/ko-scratch*",
            "--own", "G:/Temp/ko-replica*", "--budget-gib", "4.0", "--gate",
        ), 180.0, r"OK", heavy=True,
              note="external census from AGENTS.md:89; opt-in, walks G:/Temp"),
        Stage("ko_verify", ("node", "_tools/ko-verify.mjs"), 900.0,
              r"RESULT PASS[^\n]*failed=0", heavy=True,
              note="the project's one heavy gate (AGENTS.md:469); run alone under watcher"),
    ]
    return out

def _wrap_ceiling(name: str, argv: tuple[str, ...], timeout_s: float) -> tuple[tuple[str, ...], str]:
    """Use the real CPU/IO launcher when present; otherwise declare the timeout."""
    if not WRAPPER.is_file():
        return argv, f"subprocess-timeout={timeout_s:g}s (no CPU/IO wrapper at {WRAPPER})"
    wrapper_timeout = int(timeout_s + 30)
    wrapped = (
        sys.executable, str(WRAPPER), "--rotulo", f"gate-{name}",
        "--teto-cpu", CEILING_CPU, "--io", CEILING_IO,
        "--sem-coalescer", "--sem-limpar", "--timeout", str(wrapper_timeout),
        "--", *argv,
    )
    return wrapped, (f"cpu={CEILING_CPU} io={CEILING_IO} "
                     f"subprocess-timeout={timeout_s:g}s wrapper-timeout={wrapper_timeout}s")


def _load_gate_toml(repo: Path) -> tuple[dict, str | None]:
    if tomllib is None:
        return {}, "CANNOT-MEASURE: tomllib unavailable (Python <3.11); gate.toml stages not configured"
    path = repo / GATE_TOML
    try:
        doc = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as ex:
        return {}, f"CANNOT-MEASURE: cannot read {GATE_TOML} at {path}: {ex}"
    return doc, None


def _command_tiers(path: Path) -> dict[str, str]:
    """The comment before each [commands] slot names its tier (`# t1:` or `# t2`)."""
    tiers: dict[str, str] = {}
    current: str | None = None
    in_commands = False
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return tiers
    for raw in lines:
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            in_commands = line.lower() == "[commands]"
            current = None
            continue
        if not in_commands or not line:
            continue
        marker = re.match(r"#\s*(t[0-3])\b", line)
        if marker:
            current = marker.group(1) + "_s"
            continue
        slot = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if slot and current:
            tiers[slot.group(1)] = current
    return tiers


def _tier_timeout(tiers: dict, tier: str) -> tuple[float | None, str]:
    """[tiers] owns configured slot timeouts; a hardcoded value loses."""
    value = tiers.get(tier)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, f"missing {tier} in {GATE_TOML} [tiers]"
    timeout = float(value)
    note = f"timeout={timeout:g} tier={tier}"
    if timeout != DECLARED_SLOT_TIMEOUT:
        note += f" (declared timeout={DECLARED_SLOT_TIMEOUT:g} overridden by {GATE_TOML})"
    return timeout, note


def config_stages(repo: Path, doc: dict) -> list[Stage]:
    tier_values = doc.get("tiers") if isinstance(doc.get("tiers"), dict) else {}
    commands = doc.get("commands") if isinstance(doc.get("commands"), dict) else {}
    slots = _command_tiers(repo / GATE_TOML)
    out: list[Stage] = []
    for name in list(slots) + [key for key in commands if key not in slots]:
        raw = str(commands.get(name, "") or "")
        tier = slots.get(name, COMMAND_TIER_DEFAULT)
        if not raw.strip():
            out.append(Stage(name, (), 0.0,
                             note=f"skipped: not-configured (empty {GATE_TOML} slot; tier={tier})",
                             ceiling=f"none (no command configured; no child launched; tier={tier})",
                             builtin="unconfigured", optional_absent=True, tier=tier))
            continue
        timeout, note = _tier_timeout(tier_values, tier)
        if timeout is None:
            out.append(Stage(name, (), 0.0, note=f"CANNOT-MEASURE: {note}",
                             ceiling=f"none ({note}; no child launched)",
                             builtin="unconfigured", optional_absent=True, tier=tier))
            continue
        out.append(Stage(name, tuple(shlex.split(raw)), timeout,
                         note=f"{note} from {GATE_TOML}",
                         ceiling=f"subprocess-timeout={timeout:g}s {note}",
                         tier=tier, declared_timeout_s=DECLARED_SLOT_TIMEOUT))
    return out


def _pytest_probe(stage: Stage, repo: Path) -> Result:
    patterns = ("test_*.py", "*_test.py")
    skip = {".git", "_scratch", "node_modules", "__pycache__", ".codeintel"}
    try:
        found = sorted({p.relative_to(repo).as_posix()
                        for pat in patterns for p in repo.rglob(pat)
                        if not skip.intersection(p.relative_to(repo).parts)})
    except OSError as ex:
        return Result(stage.name, CANNOT, f"ceiling={stage.ceiling} cannot count pytest files: {ex}",
                      0.0, timeout_s=stage.timeout_s, skipped=True,
                      ceiling=stage.ceiling, informational=True)
    absent = [name for name in ("tests/", "pytest.ini", "pyproject.toml",
                                "setup.cfg", "tox.ini", "conftest.py")
              if not (repo / name).exists()]
    detail = (f"ceiling={stage.ceiling} NO PYTEST SUITE: {len(found)} file(s) matching "
              f"test_*.py / *_test.py; absent: {', '.join(absent) if absent else 'none'}")
    if found:
        detail += f"; found: {', '.join(found[:5])}"
    return Result(stage.name, CANNOT, detail, 0.0, timeout_s=stage.timeout_s,
                  skipped=True, ceiling=stage.ceiling, informational=True)


def overlay_stages(repo: Path) -> tuple[list[Stage], Result | None]:
    """Lane-local checks are real stages. A broken overlay refuses the run."""
    path = repo / OVERLAY
    if not path.is_file():
        return [], None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        checks = doc.get("checks") if isinstance(doc, dict) else None
        if not isinstance(checks, list):
            raise ValueError("expected an object with a 'checks' array")
        out: list[Stage] = []
        for row in checks:
            argv = row.get("argv")
            if not isinstance(row, dict) or not isinstance(argv, list) or not argv or \
                    not all(isinstance(x, str) for x in argv):
                raise ValueError("each check needs a non-empty argv of strings")
            name = str(row.get("name") or argv[-1])
            out.append(Stage(name, tuple(argv), float(row.get("timeout_s", 60.0)),
                             row.get("pass_pattern")))
    except (OSError, ValueError, TypeError) as ex:
        return [], Result("scratch_overlay", CANNOT, f"SKIPPED: bad {OVERLAY}: {ex}", 0.0, skipped=True)
    return out, None


def _tail(text: str, limit: int = 500) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return " | ".join(lines[-6:])[:limit]


def run_stage(stage: Stage, repo: Path) -> Result:
    ceiling = f"ceiling={stage.ceiling} " if stage.ceiling else ""
    if stage.builtin == "pytest":
        return _pytest_probe(stage, repo)
    if stage.builtin == "unconfigured" or not stage.argv:
        return Result(stage.name, CANNOT, f"{ceiling}{stage.note or 'skipped: not-configured'}",
                      0.0, timeout_s=stage.timeout_s, skipped=True, ceiling=stage.ceiling,
                      tier=stage.tier, informational=True)
    argv = list(stage.argv)
    exe = argv[0]
    found = shutil.which(exe) if os.path.sep not in exe and "/" not in exe else Path(exe).is_file()
    if not found:
        return Result(stage.name, CANNOT, f"{ceiling}SKIPPED: tool unavailable: {exe}", 0.0,
                      timeout_s=stage.timeout_s, skipped=True,
                      ceiling=stage.ceiling, tier=stage.tier)
    for i, arg in enumerate(argv[1:], 1):
        if arg.endswith(".py") or arg.endswith(".mjs") or arg.endswith(".cjs") or arg.endswith(".js"):
            if not (repo / arg).is_file() and not Path(arg).is_file():
                return Result(stage.name, CANNOT, f"{ceiling}SKIPPED: missing script: {arg}", 0.0,
                              timeout_s=stage.timeout_s, skipped=True,
                              ceiling=stage.ceiling, tier=stage.tier)
        elif arg.startswith(("-", "--")) is False and i == 1 and arg == ".":
            pass
    env = dict(os.environ)
    env["OMP_NUM_THREADS"] = "2"
    env["MKL_NUM_THREADS"] = "2"
    kw: dict = {
        "cwd": str(repo), "stdout": subprocess.PIPE, "stderr": subprocess.STDOUT,
        "text": True, "encoding": "utf-8", "errors": "replace", "env": env,
    }
    if os.name == "nt":
        kw["creationflags"] = CREATE_NO_WINDOW
    if os.name != "nt":
        kw["start_new_session"] = True
    t0 = time.perf_counter()
    try:
        child = subprocess.Popen(argv, **kw)
    except OSError as ex:
        return Result(stage.name, CANNOT, f"{ceiling}SKIPPED: launch failed: {ex}",
                      round(time.perf_counter() - t0, 2), timeout_s=stage.timeout_s,
                      skipped=True, ceiling=stage.ceiling, tier=stage.tier)
    try:
        body, _ = child.communicate(timeout=stage.timeout_s)
        rc = child.returncode
    except subprocess.TimeoutExpired:
        _kill_tree(child)
        try:
            child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        return Result(stage.name, CANNOT,
                      f"{ceiling}TIMEOUT after {stage.timeout_s:g}s: {stage.name}",
                      round(time.perf_counter() - t0, 2), timeout_s=stage.timeout_s,
                      ceiling=stage.ceiling, tier=stage.tier)
    wall = round(time.perf_counter() - t0, 2)
    body = body or ""
    if rc != 0:
        return Result(stage.name, FAIL,
                      f"{ceiling}child rc={rc}: {_tail(body) or '<no output>'}",
                      wall, rc, stage.timeout_s, ceiling=stage.ceiling, tier=stage.tier)
    neg_kind, neg_line = None, ""
    for line in body.splitlines():
        m = _NEG_VERDICT.match(line.strip())
        if m:
            neg_kind, neg_line = m.group(1), line.strip()
            break
    if neg_kind:
        verdict = CANNOT if neg_kind == "CANNOT-MEASURE" else FAIL
        return Result(stage.name, verdict, f"{ceiling}CHILD VERDICT {neg_kind}: {_tail(neg_line)}",
                      wall, rc, stage.timeout_s, ceiling=stage.ceiling, tier=stage.tier)
    if stage.pass_pattern and not re.search(stage.pass_pattern, body):
        return Result(stage.name, FAIL,
                      f"{ceiling}NO-PASS-VERDICT /{stage.pass_pattern}/: {_tail(body) or '<no output>'}",
                      wall, rc, stage.timeout_s, ceiling=stage.ceiling, tier=stage.tier)
    return Result(stage.name, PASS, f"{ceiling}{_tail(body) or 'rc=0'}",
                  wall, rc, stage.timeout_s, ceiling=stage.ceiling, tier=stage.tier)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run this repo's real checks with named verdicts")
    ap.add_argument("--json", action="store_true", help="print one JSON object")
    ap.add_argument("--stage", action="append", metavar="NAME",
                    help="run only this stage (repeatable); includes opt-in heavy stages")
    ap.add_argument("--list", action="store_true", help="list stage names and exit")
    ap.add_argument("--repo", default=".", help="repository root (default: this checkout)")
    args = ap.parse_args(argv)
    repo = Path(args.repo).resolve()
    doc, config_warning = _load_gate_toml(repo)
    registry = stages(repo)
    if doc:
        configured = config_stages(repo, doc)
        heavy = [st for st in registry if st.heavy]
        registry = [st for st in registry if not st.heavy] + configured + heavy
    extra, bad_overlay = overlay_stages(repo)
    if bad_overlay is not None:
        registry.append(Stage("scratch_overlay", (), 0.0))
    registry += extra
    by_name = {st.name: st for st in registry}
    not_run = [
        {"name": st.name, "reason": st.note or "opt-in heavy stage"}
        for st in registry if st.heavy and not args.stage
    ]
    if args.list:
        for st in registry:
            print(f"{st.name}\t{'heavy' if st.heavy else 'fast'}\t{st.timeout_s:g}s\t{st.note or st.argv[0]}")
        if config_warning:
            print(f"REFUSAL {config_warning}")
        return 0 if bad_overlay is None else 3
    if bad_overlay is not None:
        results = [bad_overlay]
    elif args.stage:
        selected: list[Stage] | None = []
        result = Result("", CANNOT, "", 0.0)
        for name in args.stage:
            if name in by_name:
                selected.append(by_name[name])
            else:
                selected = None
                result = Result(name, CANNOT, f"SKIPPED: unknown stage: {name}", 0.0, skipped=True)
                break
        results = ([result] if selected is None
                   else [run_stage(st, repo) for st in selected])
    else:
        results = [run_stage(st, repo) for st in registry if not st.heavy]

    # Empty gate.toml slots and the absent pytest suite are typed CANNOTs. They
    # are informational in a default run (rc 0 with passing stages), but an
    # explicit --stage selection honours the driver's rc 3 CANNOT convention.
    informational: list[str] = []
    blocking: list[Result] = []
    for r in results:
        st = by_name.get(r.name)
        if st is not None and st.optional_absent and r.verdict == CANNOT and not args.stage:
            informational.append(r.name)
        else:
            blocking.append(r)
    fails = [r.name for r in blocking if r.verdict == FAIL]
    cants = [r.name for r in blocking if r.verdict == CANNOT]
    rc = 2 if fails else 3 if cants else 0
    verdict = FAIL if fails else CANNOT if cants else PASS
    payload = {
        "schema": "scripts.gate/v1",
        "verdict": verdict,
        "rc": rc,
        "repo": str(repo),
        "stages": [r.as_dict() for r in results],
        "failed": fails,
        "cannot_measure": cants,
        "informational_cannot": informational,
        "config_warning": config_warning,
        "not_run": not_run,
    }
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        if config_warning:
            print(f"REFUSAL {config_warning}")
        for r in results:
            print(f"{r.verdict} {r.name} {r.wall_s:.2f}s {r.detail}")
        for item in not_run:
            print(f"NOT-RUN {item['name']}: {item['reason']}")
        print(f"RESULT {verdict} stages={len(results)} failed={len(fails)} "
              f"cannot_measure={len(cants)} informational_cannot={len(informational)}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
