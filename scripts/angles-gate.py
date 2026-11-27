#!/usr/bin/env python3
"""Run harness/angulos.tsv's command-bearing rows under a stage ceiling.

Each row is an assertion: cmd runs as argv (no shell), expect must appear in
its output, timeout_s bounds the row. Suites print "FAIL RED RED" lines for
their own mutant arms; rc plus the declared expect decides the row, not an
incidental word. A row with no cmd is a declared HOLE, counted as a hole,
never as a pass. An unexpressible, failing or timed-out row REFUSEs (rc 2).
"""
from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path

CREATE_NO_WINDOW = getattr(os, "CREATE_NO_WINDOW", 0x08000000)
SHELL_OPS = {"|", "||", "&&", ";", ">", ">>", "<", "&"}
TAIL = 6


def _kill(child: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(("taskkill", "/PID", str(child.pid), "/T", "/F"),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=CREATE_NO_WINDOW, timeout=5)
    else:
        child.kill()


def _refuse(line: int, why: str, output: str = "") -> int:
    tail = " | ".join(output.splitlines()[-TAIL:])[:200]
    print(f"REFUSE angles line={line} {why}{': ' + tail if tail else ''}")
    return 2


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--matrix", default="harness/angulos.tsv")
    ap.add_argument("--stage-budget", type=float, default=120.0)
    ap.add_argument("--row-timeout", type=float, default=60.0)
    args = ap.parse_args()
    repo = Path(args.repo).resolve()
    matrix = Path(args.matrix)
    if not matrix.is_absolute():
        matrix = repo / matrix
    if not matrix.is_file():
        print(f"REFUSE angles missing-matrix: {matrix}")
        return 2

    started = time.monotonic()
    deadline = started + args.stage_budget
    rows = holes = 0
    for lineno, raw in enumerate(matrix.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        cells = [cell.strip() for cell in raw.split("\t")]
        if len(cells) < 4:
            return _refuse(lineno, f"shape: {len(cells)} columns, expected 7")
        feature, angle, cmd, expect = cells[:4]
        if not cmd:
            holes += 1
            print(f"HOLE line={lineno} feature={feature} angle={angle} (no cmd; not a pass)")
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return _refuse(lineno, f"stage-ceiling={args.stage_budget:g}s exceeded")
        row_timeout = min(args.row_timeout, float(cells[6]) if len(cells) > 6 and cells[6] else args.row_timeout, remaining)
        try:
            argv = shlex.split(cmd)
        except ValueError as exc:
            return _refuse(lineno, f"command-not-expressible: {exc}")
        if not argv or any(tok in SHELL_OPS for tok in argv):
            return _refuse(lineno, f"command-not-expressible: {cmd}")
        exe = argv[0]
        if not (shutil.which(exe) if os.path.sep not in exe and "/" not in exe
                else (repo / exe).is_file() or Path(exe).is_file()):
            return _refuse(lineno, f"missing-command: {exe}")
        env = dict(os.environ, OMP_NUM_THREADS="2", MKL_NUM_THREADS="2")
        flags = CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            child = subprocess.Popen(
                argv, cwd=str(repo), stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                errors="replace", env=env, creationflags=flags,
            )
        except OSError as exc:
            return _refuse(lineno, f"launch-failed: {exc}")
        try:
            body, _ = child.communicate(timeout=row_timeout)
        except subprocess.TimeoutExpired:
            _kill(child)
            try:
                child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            return _refuse(lineno, f"row-timeout={row_timeout:g}s exceeded")
        body = str(body or "")
        if child.returncode != 0:
            return _refuse(lineno, f"row rc={child.returncode}", body)
        if expect not in body:
            return _refuse(lineno, f"expect-not-found: {expect}", body)
        rows += 1
    wall = time.monotonic() - started
    print(f"ANGLES PASS rows={rows} holes={holes} rc=0 "
          f"ceiling={args.stage_budget:g}s row-timeout<={args.row_timeout:g}s wall_s={wall:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
