"""Paired wall-clock smoke probe for the smoke_paired gate command."""
import json
import subprocess
import sys
import time


def run_once(argv: list[str]) -> int:
    start = time.perf_counter()
    # `timeout=` and `creationflags=` stay LITERAL keywords, not `**kwargs`: the
    # impl-gate rules SUBPROCESS-NO-TIMEOUT and SUBPROCESS-NO-CONSOLE read the
    # call site, and this generated script was refused by its own gate when the
    # ceiling lived in a dict. 0x08000000 is CREATE_NO_WINDOW; 0 off Windows.
    subprocess.run(
        argv,
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
        creationflags=0x08000000 if sys.platform == "win32" else 0,
    )
    return int((time.perf_counter() - start) * 1000)


def main() -> None:
    argv = [sys.executable, "-c", "print(1)"]
    print(json.dumps({"before": run_once(argv), "after": run_once(argv)}))


if __name__ == "__main__":
    main()
