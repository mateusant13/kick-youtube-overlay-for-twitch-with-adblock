#!/usr/bin/env python3
"""Drive the owner's own Chrome without touching his screen, his focus or his sound.

Owner order 2026-11-27: "you should open WINDOWS. THAT ARE SEPARETED. FROM MY TABS", and
"if you gonna open one, close the last one". So this file has ONE shape: a separate window,
parked off his screen, silent, started on purpose, and closed by the caller.

WHAT THIS FILE DOES, every step measured before it was written: opens a SEPARATE WINDOW in his
Chrome (`Target.createTarget{newWindow:true, background:true}` - never a tab in his strip),
pauses it at creation, attaches a mute the page cannot lift, resumes it, parks it at
(-32000,-32000) until Chrome reads the bounds back, reloads once so the mute is on the document
that runs, and with `--play` sends ONE trusted click at the video centre - which is what actually
starts a player in a window he never touched. `state` reports what it holds, `close`/`reap`
remove it. Nothing of his is ever navigated, clicked, muted or focused.

WHY NOTHING ELSE (all measured 2026-11-27, Chrome 158, port 9222, profile
`C:\\ChromeDebugProfile`, this shell at MEDIUM integrity):

  * Alpha-0 layered window (the mechanism in `I:/!manager/tools/bg-window.py`):
    the port is kept below, but Win32 refuses it here. That Chrome runs at a
    HIGHER integrity than this shell: `SetWindowLongPtrW` returns 0 with
    `GetLastError()==5`, `OpenProcessToken` on its pid is denied. The ported
    preflight refuses BEFORE creating anything instead of creating a window it
    cannot hide. If that Chrome is ever started by a MEDIUM process (this tool's
    own integrity), `hide-window` works unchanged - it is the only invisible
    mechanism there is, because a window must stay ON screen to keep rendering.
  * CDP window (`Target.createTarget{newWindow:true}`): paints maximized at
    (-8,-8) for ~500 ms and `Browser.setWindowBounds` is ignored until Chrome
    finishes showing it (sampled every 5 ms: first on-screen sample at 125 ms,
    last at 609 ms). `chrome.windows.create({left:-32000})` is refused outright:
    "Bounds must be at least 50% within visible screen space."
  * Extension window with `{state:'minimized', focused:false}`: Chrome returned
    `state:"normal"` at (10,0), painted it and took the owner's focus. Measured
    on the owner, who reported it.
  * A tab in his strip (`newWindow:false`): keeps his focus, but it is a tab in HIS tab strip -
    he sees it, and that is the shape he ordered replaced.
  * Separate window parked off screen (THIS FILE): focus unchanged, nothing on his screen, the
    mute lock holds, and with one trusted click the clock advances at wall rate (`+2.07 s` per
    2 s over 8 samples). Parking is the only hiding route left on a Chrome we cannot style.

Usage:
  python _tools/ko-bg-window.py open  --url https://example.com/ [--label name] [--play]
  python _tools/ko-bg-window.py state [--label name | --target <id>]
  python _tools/ko-bg-window.py list
  python _tools/ko-bg-window.py close [--label name | --target <id>]
  python _tools/ko-bg-window.py reap
  python _tools/ko-bg-window.py hide-window --target <id>   (needs a styleable Chrome)

Options: --relay http://127.0.0.1:9222, --chrome chrome.exe, --no-mute, --play,
         --width N, --height N.
"""
import argparse
import ctypes
import json
import os
import re
import sys
import time
import urllib.request
from ctypes import wintypes as wt

u32 = ctypes.windll.user32
k32 = ctypes.windll.kernel32

GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
LWA_ALPHA = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020
WM_CLOSE = 0x0010
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008

REGISTRY = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
                        "omp", "ko-bg-tabs.jsonl")
COMPACT_HOURS = 24

if hasattr(u32, "GetWindowLongPtrW"):
    u32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
    u32.GetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int]
    u32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
    u32.SetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_ssize_t]
    _get_long, _set_long = u32.GetWindowLongPtrW, u32.SetWindowLongPtrW
else:  # 32-bit Python
    _get_long, _set_long = u32.GetWindowLongW, u32.SetWindowLongW


# ------------------------------------------------------------------ registry

def registry_read() -> list[dict]:
    try:
        with open(REGISTRY, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]
    except (OSError, json.JSONDecodeError):
        return []


def registry_write(entries: list[dict]) -> None:
    try:
        os.makedirs(os.path.dirname(REGISTRY), exist_ok=True)
        tmp = REGISTRY + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            for e in entries:
                fh.write(json.dumps(e) + "\n")
        os.replace(tmp, REGISTRY)
    except OSError:
        pass


def registry_append(entry: dict) -> None:
    entries = registry_read()
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - COMPACT_HOURS * 3600))
    kept = [e for e in entries
            if not e.get("closed") or (e.get("closed_ts") or e.get("ts", "")) > cutoff]
    kept.append(entry)
    registry_write(kept)


def mark_closed(target_id: str) -> None:
    if not target_id:
        return
    entries = registry_read()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for e in entries:
        if str(e.get("target_id", "")) == target_id and not e.get("closed"):
            e["closed"] = True
            e["closed_ts"] = now
    registry_write(entries)


def find_entry(label: str | None, target: str | None) -> dict | None:
    for e in reversed(registry_read()):
        if e.get("closed"):
            continue
        if target and e.get("target_id") == target:
            return e
        if label and e.get("label") == label:
            return e
    return None


# ------------------------------------------------------------------ the audio lock

# Element-level mute that PAGE SCRIPT CANNOT LIFT: `muted` and `volume` are
# redefined on the prototype as constants. Polling is not enough - measured on
# twitch.tv the player re-mutes itself back to `muted:false, volume:1` inside a
# 500 ms poll window, which is audible for the fraction of a second it lives.
# Installed while the tab is paused, so the first script the page runs already
# sees a muted element (which is also what lets Chrome autoplay it at all).
LOCK_MUTE = r"""
(function () {
  if (window.__koAudioLock) return 'already';
  window.__koAudioLock = true;
  var P = window.HTMLMediaElement && HTMLMediaElement.prototype;
  if (!P) return 'no-media';
  try {
    Object.defineProperty(P, 'muted', {
      configurable: false, get: function () { return true; }, set: function () {}
    });
    Object.defineProperty(P, 'volume', {
      configurable: false, get: function () { return 0; }, set: function () {}
    });
  } catch (e) { return 'failed:' + e.name; }
  return 'locked';
})()
"""


class CDP:
    """Minimal RFC6455 client. The JS tools use `_tools/ko-cdp.mjs`; this file is
    Python because the hiding counterpart is Win32 through ctypes, and a second
    port of that to Node would be a second thing to keep correct."""

    def __init__(self, url: str, timeout: float = 6.0):
        import base64
        import socket
        from urllib.parse import urlparse
        u = urlparse(url)
        self.sock = socket.create_connection((u.hostname or "127.0.0.1", u.port or 80),
                                             timeout=timeout)
        # Bound EVERY read, not just the connect: a devtools socket that accepts
        # the TCP connection and then says nothing must fail by name instead of
        # blocking the tool forever (the gate refuses an unbounded read).
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path + (("?" + u.query) if u.query else "")
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\n"
                           "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            try:
                chunk = self.sock.recv(4096)
            except socket.timeout as e:
                raise OSError(f"devtools handshake timed out after {timeout}s") from e
            if not chunk:
                raise OSError("devtools closed the handshake")
            head += chunk
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise OSError("devtools refused the socket: "
                          + head.split(b"\r\n", 1)[0].decode("latin1"))
        self._id = 0
        self.events: list[dict] = []
        self._buf = head.split(b"\r\n\r\n", 1)[1]
        # Reads stay bounded (10 s) for the life of the socket; each `call` has a
        # tighter deadline of its own, so a silent devtools fails by name.
        self.sock.settimeout(10.0)

    def _send(self, text: str) -> None:
        payload = text.encode("utf-8")
        head = bytearray([0x81])
        n = len(payload)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += n.to_bytes(2, "big")
        else:
            head.append(0x80 | 127)
            head += n.to_bytes(8, "big")
        mask = os.urandom(4)
        head += mask
        self.sock.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise OSError("devtools closed the socket")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _frame(self) -> str:
        b0, b1 = self._exact(2)
        n = b1 & 0x7F
        if n == 126:
            n = int.from_bytes(self._exact(2), "big")
        elif n == 127:
            n = int.from_bytes(self._exact(8), "big")
        payload = self._exact(n)
        if b0 & 0x0F == 0x8:
            raise OSError("devtools sent close")
        return payload.decode("utf-8", "replace")

    def call(self, method: str, params: dict | None = None, timeout: float = 8.0) -> dict:
        self._id += 1
        mid = self._id
        params = dict(params or {})
        sid = params.pop("sessionId", None)   # flat mode: beside `method`
        msg = {"id": mid, "method": method, "params": params}
        if sid:
            msg["sessionId"] = sid
        self._send(json.dumps(msg))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            reply = json.loads(self._frame())
            if reply.get("id") == mid:
                return reply
            if reply.get("method"):
                self.events.append(reply)
        raise TimeoutError(method)

    def wait_event(self, method: str, where=None, timeout: float = 10.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for i, ev in enumerate(self.events):
                if ev.get("method") == method and (not where or where(ev.get("params") or {})):
                    return self.events.pop(i)
            reply = json.loads(self._frame())
            if reply.get("method"):
                self.events.append(reply)
        raise TimeoutError(method)

    def evaluate(self, expression: str, session: str, timeout: float = 8.0):
        reply = self.call("Runtime.evaluate",
                          {"expression": expression, "returnByValue": True,
                           "awaitPromise": True, "sessionId": session}, timeout=timeout)
        result = reply.get("result") or {}
        if result.get("exceptionDetails"):
            return {"err": str(result["exceptionDetails"].get("text"))[:160]}
        return (result.get("result") or {}).get("value")

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def browser_ws(relay: str) -> str:
    version = json.loads(urllib.request.urlopen(f"{relay}/json/version", timeout=5).read())
    return version["webSocketDebuggerUrl"].replace("http://", "ws://")


def page_targets(relay: str) -> list[dict]:
    with urllib.request.urlopen(relay + "/json/list", timeout=5) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    return [t for t in data if isinstance(t, dict) and t.get("type") == "page"]


def close_target(relay: str, target_id: str) -> bool:
    if not target_id:
        return False
    try:
        req = urllib.request.Request(f"{relay}/json/close/{target_id}")
        with urllib.request.urlopen(req, timeout=5) as r:
            body = r.read().decode("utf-8", "replace")
        return "closing" in body.lower() or "closed" in body.lower()
    except Exception:
        return False


# ------------------------------------------------------------------ hiding (kept for a styleable Chrome)

def preflight(relay: str, chrome_img: str) -> dict:
    """Can this process style that Chrome's windows at all? Measured, not assumed.

    Writes back the value a window already has (a no-op) on any existing window
    of that browser: if Win32 refuses, every later hide attempt would fail
    *after* a window had already been painted.
    """
    sample = 0

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(h, _l):
        nonlocal sample
        if not sample and u32.IsWindowVisible(h):
            pid = wt.DWORD(0)
            u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
            handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
            if handle:
                try:
                    buf = ctypes.create_unicode_buffer(1024)
                    size = wt.DWORD(1024)
                    if k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                        name = buf.value.replace("\\", "/").rsplit("/", 1)[-1].lower()
                        if name == chrome_img:
                            sample = int(h)
                finally:
                    k32.CloseHandle(handle)
        return True

    u32.EnumWindows(cb, 0)
    if not sample:
        return {"ok": False, "refused": True,
                "why": f"no visible {chrome_img} window to test against"}
    pid = wt.DWORD(0)
    u32.GetWindowThreadProcessId(wt.HWND(sample), ctypes.byref(pid))
    ex = _get_long(sample, GWL_EXSTYLE)
    ctypes.set_last_error(0)
    _set_long(sample, GWL_EXSTYLE, ex)
    err = ctypes.get_last_error()
    return {"ok": err == 0, "browser_pid": pid.value, "write_err": err,
            "why": None if err == 0 else
                   (f"SetWindowLongPtr refused with err {err} "
                    f"({ctypes.FormatError(err).strip()}): this process cannot style that "
                    f"Chrome's windows (integrity above ours). Start that Chrome from the "
                    f"owner's own session, or run this tool at its level.")}


def make_silent(hwnd: int) -> None:
    """Alpha 0 + click-through + toolwindow + never activatable, on the window and
    its children (Chrome creates child surfaces that would take his clicks)."""
    def one(h: int) -> None:
        ex = _get_long(h, GWL_EXSTYLE)
        _set_long(h, GWL_EXSTYLE,
                  ex | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)
        u32.SetLayeredWindowAttributes(h, 0, 0, LWA_ALPHA)

    one(hwnd)

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def child(h, _l):
        one(int(h))
        return True

    u32.EnumChildWindows(ctypes.c_void_p(hwnd), child, 0)


def is_silent(hwnd: int) -> bool:
    ex = _get_long(hwnd, GWL_EXSTYLE)
    wanted = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
    if (ex & wanted) != wanted:
        return False
    crkey, alpha, flags = wt.DWORD(0), ctypes.c_ubyte(0), ctypes.c_ulong(0)
    if not u32.GetLayeredWindowAttributes(hwnd, ctypes.byref(crkey),
                                          ctypes.byref(alpha), ctypes.byref(flags)):
        return False
    return bool(flags.value & LWA_ALPHA) and alpha.value == 0


# ------------------------------------------------------------------ commands

_OWNER_SURFACE = re.compile(
    r"^(?:https?://(?:127\.0\.0\.1|localhost|\[::1\]):8010(?:[/?#]|$))", re.IGNORECASE)


PARK = -32000


def restore_foreground(h_prev: int) -> bool:
    """Hand the owner's focus back if Chrome took it (AttachThreadInput, the same
    trick `I:/!manager/tools/focus-open.py` uses - Windows only lets the current
    foreground process steal it, so we attach to it first)."""
    if not h_prev:
        return False
    pid = wt.DWORD(0)
    fg_thread = u32.GetWindowThreadProcessId(u32.GetForegroundWindow(), ctypes.byref(pid))
    this_thread = k32.GetCurrentThreadId()
    attached = False
    if fg_thread and fg_thread != this_thread:
        attached = bool(u32.AttachThreadInput(this_thread, fg_thread, True))
    u32.SetForegroundWindow(h_prev)
    u32.BringWindowToTop(h_prev)
    if attached:
        u32.AttachThreadInput(this_thread, fg_thread, False)
    return u32.GetForegroundWindow() == h_prev


def _start_playback(ws: "CDP", sid: str, attempts: int = 40) -> dict:
    """Make a live player start without touching the owner's screen.

    Measured 2026-11-27 on twitch.tv in a window parked at (-32000,-32000): the
    player mounts, but `currentTime` stays 0 forever until the page receives a
    TRUSTED input event - a CDP `Input.dispatchMouseEvent` is trusted, so one
    press/release on the video's centre is what starts it. After that the clock
    advances at wall rate (2.07 s per 2 s over 8 samples), `muted:true` holds,
    `visibilityState:"visible"`, `hasFocus:true`, and `GetForegroundWindow()`
    never changes. Verified; do not replace this with `video.play()`, which a
    page-level call cannot do (no user activation) and which would be a page
    mutation rather than a gesture.
    """
    receipt = {"box": None, "advanced": None, "samples": []}
    for _ in range(attempts):
        try:
            box = ws.evaluate(
                "(()=>{const v=document.querySelector('video');"
                "if(!v||v.readyState<2)return null;const r=v.getBoundingClientRect();"
                "return r.width>10?JSON.stringify([r.x+r.width/2,r.y+r.height/2]):null})()", sid)
        except TimeoutError:
            time.sleep(0.5)
            continue
        if isinstance(box, str) and box.startswith("["):
            receipt["box"] = json.loads(box)
            break
        time.sleep(0.5)
    if not receipt["box"]:
        return receipt
    x, y = receipt["box"]
    for kind in ("mousePressed", "mouseReleased"):
        ws.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left",
                                             "clickCount": 1, "sessionId": sid})
    probe = ("(()=>{const v=document.querySelector('video');"
             "return v?JSON.stringify([+v.currentTime.toFixed(2),v.paused,v.muted]):null})()")
    for _ in range(6):
        time.sleep(1.2)
        try:
            row = ws.evaluate(probe, sid, timeout=6)
        except TimeoutError:
            continue
        if isinstance(row, str) and row.startswith("["):
            receipt["samples"].append(json.loads(row))
    if len(receipt["samples"]) >= 2:
        first, last = receipt["samples"][0][0], receipt["samples"][-1][0]
        receipt["advanced"] = round(last - first, 2)
    return receipt


def cmd_open(args) -> int:
    if _OWNER_SURFACE.match(args.url):
        print(json.dumps({"ok": False, "err": "refused: the owner's own app surface"}))
        return 2
    relay = args.relay.rstrip("/")
    fg_before = u32.GetForegroundWindow()
    before_ids = {t["id"] for t in page_targets(relay)}

    ws = CDP(browser_ws(relay))
    try:
        # A SEPARATE WINDOW, never a tab in his tab strip (owner order
        # 2026-11-27: "you're using new tabs. you should open WINDOWS. that are
        # separated from my tabs"). Created paused so the audio lock is in place
        # before the first script, background so Chrome does not activate it.
        ws.call("Target.setAutoAttach", {"autoAttach": True,
                                         "waitForDebuggerOnStart": True, "flatten": True})
        created = ws.call("Target.createTarget",
                          {"url": args.url, "newWindow": True, "background": True})
        target_id = (created.get("result") or {}).get("targetId")
        if not target_id:
            raise OSError(f"createTarget refused: {created.get('error')}")
        ev = ws.wait_event("Target.attachedToTarget",
                           where=lambda p: (p.get("targetInfo") or {}).get("targetId") == target_id)
        sid = ev["params"]["sessionId"]
        receipt = {"target_id": target_id, "label": args.label, "url": args.url,
                   "paused_at_create": bool(ev["params"].get("waitingForDebugger")),
                   "muted": False, "parked": False}
        ws.call("Page.enable", {"sessionId": sid})
        if not args.no_mute:
            ws.call("Page.addScriptToEvaluateOnNewDocument",
                    {"source": LOCK_MUTE, "sessionId": sid})
        # A window nobody looks at is throttled: keep the renderer honest while
        # it stays out of his view.
        ws.call("Emulation.setFocusEmulationEnabled", {"enabled": True, "sessionId": sid})
        ws.call("Page.setWebLifecycleState", {"state": "active", "sessionId": sid})
        ws.call("Runtime.runIfWaitingForDebugger", {"sessionId": sid})

        win = ws.call("Browser.getWindowForTarget", {"targetId": target_id})
        window_id = (win.get("result") or {}).get("windowId")
        receipt["window_id"] = window_id
        # Chrome ignores bounds until it has finished showing the window, so this
        # is retried on both sides of the resume (measured: the first write is
        # dropped, a later one sticks).
        for attempt in range(12):
            if window_id:
                ws.call("Browser.setWindowBounds",
                        {"windowId": window_id,
                         "bounds": {"left": PARK, "top": PARK,
                                    "width": args.width, "height": args.height,
                                    "windowState": "normal"}})
                bounds = ((ws.call("Browser.getWindowBounds", {"windowId": window_id})
                           .get("result") or {}).get("bounds") or {})
                if bounds.get("left", 0) <= -30000:
                    receipt["parked"] = True
                    break
            time.sleep(0.1)

        if not args.no_mute:
            # The first document is created before this session's init scripts are
            # registered, so one reload is what puts the lock on the document that
            # actually runs (measured: without it `__koAudioLock` reads false).
            ws.call("Page.reload", {"sessionId": sid})
            time.sleep(1.5)
            receipt["muted"] = ws.evaluate("window.__koAudioLock === true", sid) is True

        if args.play:
            receipt["play"] = _start_playback(ws, sid)

        if u32.GetForegroundWindow() != fg_before:
            receipt["focus_stolen"] = True
            receipt["focus_restored"] = restore_foreground(fg_before)
        else:
            receipt["focus_stolen"] = False
        receipt["focus_moved"] = u32.GetForegroundWindow() != fg_before
        receipt["new_targets"] = len({t["id"] for t in page_targets(relay)} - before_ids)

        if not receipt["new_targets"]:
            close_target(relay, target_id)
            print(json.dumps({"ok": False, "err": "window did not materialize",
                              "receipt": receipt}))
            return 1
        registry_append({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                         "target_id": target_id, "window_id": window_id,
                         "label": args.label, "url": args.url})
        print(json.dumps({"ok": True, **receipt}))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "err": f"{type(e).__name__}: {e}"}))
        return 1
    finally:
        ws.close()


def _attach(relay: str, target_id: str) -> tuple[CDP, str]:
    ws = CDP(browser_ws(relay))
    att = ws.call("Target.attachToTarget", {"targetId": target_id, "flatten": True})
    sid = (att.get("result") or {}).get("sessionId")
    if not sid:
        ws.close()
        raise OSError(f"cannot attach: {att.get('error')}")
    return ws, sid


def cmd_state(args) -> int:
    relay = args.relay.rstrip("/")
    entry = find_entry(args.label, args.target)
    target_id = args.target or (entry or {}).get("target_id")
    if not target_id:
        print(json.dumps({"ok": False, "err": "no such probe tab"}))
        return 1
    try:
        ws, sid = _attach(relay, target_id)
    except OSError as e:
        print(json.dumps({"ok": False, "err": str(e)}))
        return 1
    try:
        value = ws.evaluate(
            "JSON.stringify({href:location.href,rs:document.readyState,title:document.title,"
            "videos:document.querySelectorAll('video,audio').length,"
            "muted:[...document.querySelectorAll('video,audio')].map(v=>v.muted),"
            "ct:[...document.querySelectorAll('video,audio')].map(v=>+v.currentTime.toFixed(2)),"
            "lock:window.__koAudioLock===true,vis:document.visibilityState})", sid)
        print(json.dumps({"ok": True, "target_id": target_id, "tab": json.loads(value)
                          if isinstance(value, str) else value}))
        return 0
    except (TimeoutError, ValueError) as e:
        print(json.dumps({"ok": False, "err": f"{type(e).__name__}: {e}"}))
        return 1
    finally:
        ws.close()


def cmd_list(_args) -> int:
    live = set()
    try:
        live = {t["id"] for t in page_targets(_args.relay.rstrip("/"))}
    except Exception:
        pass
    rows = [{"target_id": e.get("target_id"), "label": e.get("label"), "url": e.get("url"),
             "ts": e.get("ts"), "closed": bool(e.get("closed")),
             "open": e.get("target_id") in live}
            for e in registry_read()]
    print(json.dumps({"registry": REGISTRY, "rows": rows}, indent=2))
    return 0


def cmd_close(args) -> int:
    relay = args.relay.rstrip("/")
    entry = find_entry(args.label, args.target)
    target_id = args.target or (entry or {}).get("target_id")
    if not target_id:
        print(json.dumps({"ok": False, "err": "no such probe tab"}))
        return 1
    ok = close_target(relay, target_id)
    mark_closed(target_id)
    print(json.dumps({"ok": ok, "target_id": target_id}))
    return 0 if ok else 1


def cmd_reap(args) -> int:
    relay = args.relay.rstrip("/")
    live = {t["id"] for t in page_targets(relay)}
    closed = []
    for e in registry_read():
        tid = e.get("target_id")
        if e.get("closed") or tid not in live:
            continue
        if close_target(relay, tid):
            mark_closed(tid)
            closed.append(tid)
    print(json.dumps({"closed": closed, "count": len(closed)}))
    return 0


def cmd_hide_window(args) -> int:
    """Alpha-0 a window of the connected Chrome. Works only when this process can
    style that browser's windows (see preflight); refuses before painting."""
    relay = args.relay.rstrip("/")
    pre = preflight(relay, args.chrome.replace("\\", "/").rsplit("/", 1)[-1].lower())
    if not pre.get("ok"):
        print(json.dumps({"ok": False, "err": pre.get("why"), "preflight": pre}))
        return 3
    try:
        ws, sid = _attach(relay, args.target)
    except OSError as e:
        print(json.dumps({"ok": False, "err": str(e)}))
        return 1
    try:
        win = ws.call("Browser.getWindowForTarget", {"targetId": args.target})
        wid = (win.get("result") or {}).get("windowId")
        ws.close()
        if not wid:
            print(json.dumps({"ok": False, "err": "no window for that target"}))
            return 1
        out = {}
        for _ in range(20):
            for h in _top_hwnds():
                make_silent(h)
                if is_silent(h):
                    out = {"hwnd": h, "silent": True}
                    break
            if out:
                break
            time.sleep(0.05)
        print(json.dumps({"ok": bool(out), "window_id": wid, **out}))
        return 0 if out else 1
    finally:
        ws.close()


def _top_hwnds() -> list[int]:
    out: list[int] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(h, _l):
        if u32.IsWindowVisible(h):
            out.append(int(h))
        return True

    u32.EnumWindows(cb, 0)
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--relay", default=os.environ.get("KO_RELAY", "http://127.0.0.1:9222"))
    p.add_argument("--chrome", default="chrome.exe", help="window image name (hide-window)")
    sub = p.add_subparsers(dest="cmd", required=True)

    o = sub.add_parser("open", help="open a background tab (no window, no focus, no sound)")
    o.add_argument("--url", required=True)
    o.add_argument("--label", default="probe")
    o.add_argument("--no-mute", action="store_true")
    o.add_argument("--play", action="store_true",
                   help="dispatch one trusted click at the video centre so a player starts")
    o.add_argument("--width", type=int, default=1280)
    o.add_argument("--height", type=int, default=800)
    o.set_defaults(fn=cmd_open)

    s = sub.add_parser("state", help="what does the probe tab hold right now")
    s.add_argument("--label")
    s.add_argument("--target")
    s.set_defaults(fn=cmd_state)

    l = sub.add_parser("list", help="registered probe tabs")
    l.set_defaults(fn=cmd_list)

    c = sub.add_parser("close", help="close one probe tab")
    c.add_argument("--label")
    c.add_argument("--target")
    c.set_defaults(fn=cmd_close)

    r = sub.add_parser("reap", help="close every registered probe tab still open")
    r.set_defaults(fn=cmd_reap)

    h = sub.add_parser("hide-window", help="alpha-0 a window (needs a styleable Chrome)")
    h.add_argument("--target", required=True)
    h.set_defaults(fn=cmd_hide_window)

    args = p.parse_args()
    if getattr(args, "fn", None) in (cmd_state, cmd_close) and not (args.label or args.target):
        p.error("state/close need --label or --target")
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
