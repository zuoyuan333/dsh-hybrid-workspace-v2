#!/usr/bin/env python3
"""Restart the DeepSeek Harness desktop app.

Usage:
  scripts/restart-dsh.py --check
  scripts/restart-dsh.py --dry-run
  scripts/restart-dsh.py --detach --delay 15
  scripts/restart-dsh.py --force --timeout 20

The detached form returns immediately, waits --delay seconds, quits the app,
settles briefly, launches it again, and writes a result JSON. If the new main
process exits during startup or never creates its desktop host, the worker
retries once. It is safe to call from inside a DSH session: the worker is
started in a new session and outlives the old app.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

DEFAULT_APP = Path("/Applications/DeepSeek Harness.app")
DEFAULT_LOG = Path.home() / ".dsh" / "restart-dsh.log"
DEFAULT_RESULT = Path.home() / ".dsh" / "restart-dsh-result.json"
EXE_REL = Path("Contents/MacOS/DeepSeek Harness")
HOST_MARKER = "dsh-desktop-host/lib/index.js"
MAIN_STABLE_SECONDS = 1.5


def stamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def log(message: str) -> None:
    print(f"{stamp()} {message}", flush=True)


def run(cmd, timeout=15):
    return subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)


def ps_rows():
    """Return (pid, ppid, command) rows from ps."""
    try:
        out = subprocess.check_output(["ps", "-axo", "pid=,ppid=,command="], text=True)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(f"cannot read process table: {exc}") from exc
    rows = []
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) != 3:
            continue
        try:
            pid = int(parts[0])
            ppid = int(parts[1])
        except ValueError:
            continue
        rows.append((pid, ppid, parts[2].strip()))
    return rows


def main_pids(app: Path):
    exe = str(app / EXE_REL)
    return [pid for pid, _ppid, cmd in ps_rows() if cmd == exe]


def host_pids_for(main_ids):
    if isinstance(main_ids, int):
        main_ids = {main_ids}
    else:
        main_ids = set(main_ids)
    if not main_ids:
        return []
    return [pid for pid, ppid, cmd in ps_rows() if ppid in main_ids and HOST_MARKER in cmd]


def app_process_pids(app: Path):
    """Return the main process plus helpers/renderers inside this bundle."""
    prefix = str(app) + os.sep
    exe = str(app / EXE_REL)
    return [
        pid
        for pid, _ppid, cmd in ps_rows()
        if cmd == exe or cmd.startswith(prefix)
    ]


def pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_gone(pids, timeout: float) -> bool:
    deadline = time.monotonic() + max(0.0, timeout)
    while time.monotonic() < deadline:
        if not any(pid_exists(pid) for pid in pids):
            return True
        time.sleep(0.25)
    return not any(pid_exists(pid) for pid in pids)


def terminate_processes(pids, timeout: float, force: bool, label: str) -> None:
    pids = [pid for pid in pids if pid_exists(pid)]
    if not pids:
        return
    log(f"terminating {label}: {', '.join(str(pid) for pid in pids)}")
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError as exc:
            log(f"cannot SIGTERM {pid}: {exc}")
    if wait_gone(pids, timeout):
        return
    if not force:
        raise RuntimeError(f"{label} did not exit within {timeout:g}s; rerun with --force")
    log(f"force killing {label}: {', '.join(str(pid) for pid in pids)}")
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError as exc:
            log(f"cannot SIGKILL {pid}: {exc}")
    if not wait_gone(pids, 5):
        raise RuntimeError(f"{label} is still running after SIGKILL")


def app_name(app: Path) -> str:
    info = app / "Contents" / "Info"
    try:
        out = subprocess.check_output(
            ["defaults", "read", str(info), "CFBundleName"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        if out:
            return out
    except (OSError, subprocess.SubprocessError):
        pass
    return app.stem


def quit_app(main_ids, name: str, timeout: float, force: bool) -> None:
    if not main_ids:
        return
    log(f"quitting {name}: {', '.join(str(pid) for pid in main_ids)}")
    try:
        result = run(["osascript", "-e", f'tell application "{name}" to quit'], timeout=15)
        if result.returncode == 0:
            log("AppleScript quit requested")
        else:
            detail = (result.stderr or result.stdout or "unknown error").strip()
            log(f"AppleScript quit failed: {detail}")
    except subprocess.TimeoutExpired:
        log("AppleScript quit timed out")
    except Exception as exc:
        log(f"AppleScript quit error: {exc}")

    if wait_gone(main_ids, timeout):
        return
    log(f"app still running after {timeout:g}s; sending SIGTERM")
    terminate_processes(main_ids, timeout=timeout, force=force, label=name)


def wait_new_main(old_ids, app: Path, timeout: float):
    old_ids = set(old_ids)
    deadline = time.monotonic() + max(1.0, timeout)
    while time.monotonic() < deadline:
        fresh = [pid for pid in main_pids(app) if pid not in old_ids]
        if fresh:
            return fresh
        time.sleep(0.5)
    raise RuntimeError(f"new DeepSeek Harness process did not appear within {timeout:g}s")


def wait_new_host(main_ids, timeout: float):
    deadline = time.monotonic() + max(1.0, timeout)
    while time.monotonic() < deadline:
        hosts = host_pids_for(main_ids)
        if hosts:
            return hosts
        time.sleep(0.5)
    return []


def wait_main_stable(main_ids, seconds: float):
    """Return the pids that survive a short startup window."""
    deadline = time.monotonic() + max(0.0, seconds)
    while time.monotonic() < deadline:
        if not any(pid_exists(pid) for pid in main_ids):
            return []
        time.sleep(0.25)
    return [pid for pid in main_ids if pid_exists(pid)]


def launch_app(app: Path) -> None:
    log(f"opening {app}")
    try:
        result = run(["/usr/bin/open", "-a", str(app)], timeout=20)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("open -a timed out") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "open failed").strip()
        raise RuntimeError(f"cannot launch app: {detail}")


def activate_app(name: str) -> None:
    try:
        result = run([
            "osascript", "-e", f'tell application "{name}" to activate'
        ], timeout=10)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "activate failed").strip()
            log(f"activate failed: {detail}")
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"activate error: {exc}")


def port_for_pid(pid: int):
    try:
        result = run(
            ["lsof", "-nP", "-a", "-p", str(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        if not line.startswith("n"):
            continue
        addr = line[1:]
        if addr.startswith("["):
            match = re.search(r"\]:(\d+)$", addr)
        else:
            match = re.search(r":(\d+)$", addr)
        if match:
            return int(match.group(1))
    return None


def page_probe(port: int):
    url = f"http://127.0.0.1:{port}/hybrid-workspace/"
    try:
        result = run(["/usr/bin/curl", "-fsS", "--max-time", "3", url], timeout=6)
    except subprocess.TimeoutExpired:
        return {"url": url, "ok": False, "error": "curl timeout"}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"url": url, "ok": False, "error": str(exc)}
    text = result.stdout
    match = re.search(r"v(\d+\.\d+\.\d+)", text)
    return {
        "url": url,
        "ok": result.returncode == 0 and "混合工作区" in text,
        "version": match.group(1) if match else None,
        "bytes": len(text),
        "error": None if result.returncode == 0 else (result.stderr or "curl failed").strip(),
    }


def wait_for_page(hosts, timeout: float):
    deadline = time.monotonic() + max(1.0, timeout)
    last = {"ok": False, "url": None, "version": None}
    while time.monotonic() < deadline:
        for host in hosts:
            port = port_for_pid(host)
            if not port:
                continue
            probe = page_probe(port)
            last = {"hostPid": host, **probe}
            if probe.get("ok") and probe.get("version"):
                return last
        time.sleep(0.5)
    return last


def write_result(path: Path, result: dict) -> None:
    result.setdefault("at", stamp())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    except OSError as exc:
        log(f"cannot write result {path}: {exc}")


def check(app: Path) -> int:
    exists = app.is_dir()
    mains = main_pids(app) if exists else []
    hosts = host_pids_for(mains) if mains else []
    info = {
        "app": str(app),
        "exists": exists,
        "mainPids": mains,
        "hostPids": hosts,
        "log": str(DEFAULT_LOG),
        "result": str(DEFAULT_RESULT),
    }
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0 if exists else 1


def schedule(args, app: Path):
    log_path = Path(args.log).expanduser()
    result_path = Path(args.result).expanduser()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker",
        "--app", str(app),
        "--delay", str(args.delay),
        "--timeout", str(args.timeout),
        "--ready-timeout", str(args.ready_timeout),
        "--settle", str(args.settle),
        "--attempts", str(args.attempts),
        "--log", str(log_path),
        "--result", str(result_path),
    ]
    if args.force:
        cmd.append("--force")
    with open(log_path, "ab") as log_file:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    log(f"scheduled restart worker pid={proc.pid} delay={args.delay:g}s log={log_path}")
    return 0


def restart(args, app: Path, result_path: Path) -> int:
    started = time.monotonic()
    name = app_name(app)
    old_main = main_pids(app)
    old_hosts = host_pids_for(old_main)
    old_app_pids = app_process_pids(app)
    result = {
        "status": "starting",
        "app": str(app),
        "appName": name,
        "oldMainPids": old_main,
        "oldHostPids": old_hosts,
        "log": str(Path(args.log).expanduser()),
    }
    log(f"app={app} name={name} old_main={old_main} old_hosts={old_hosts}")

    if not app.is_dir():
        raise RuntimeError(f"app not found: {app}")
    if args.dry_run:
        log("dry run: would quit the app, launch it again, and verify /hybrid-workspace/")
        return 0

    if old_main:
        quit_app(old_main, name, args.timeout, args.force)
        remaining_hosts = [pid for pid in old_hosts if pid_exists(pid)]
        if remaining_hosts:
            terminate_processes(
                remaining_hosts,
                timeout=min(10.0, args.timeout),
                force=args.force,
                label="old desktop host",
            )
        remaining_app = [pid for pid in old_app_pids if pid_exists(pid)]
        if remaining_app:
            terminate_processes(
                remaining_app,
                timeout=min(10.0, args.timeout),
                force=args.force,
                label="old app helpers",
            )
    else:
        log("app is not running; launching")
        if old_app_pids:
            terminate_processes(
                old_app_pids,
                timeout=min(10.0, args.timeout),
                force=args.force,
                label="stale app processes",
            )

    if args.settle > 0:
        # LaunchServices and Electron's single-instance socket can outlive the
        # old main process by a fraction of a second. Launching too early used
        # to create a short-lived "ghost" main process with no desktop host.
        log(f"settling {args.settle:g}s after the old app exited")
        time.sleep(args.settle)

    launch_app(app)
    seen = set(old_main)
    new_main = []
    new_hosts = []
    attempts = max(1, args.attempts)
    for attempt in range(1, attempts + 1):
        try:
            candidate = wait_new_main(seen, app, args.ready_timeout)
        except RuntimeError as exc:
            log(f"launch attempt {attempt}/{attempts}: {exc}")
            if attempt >= attempts:
                raise
            log(f"retrying launch in {args.settle:g}s")
            time.sleep(args.settle)
            launch_app(app)
            continue
        seen.update(candidate)
        log(f"new main pid(s): {candidate} (attempt {attempt}/{attempts})")
        stable = wait_main_stable(candidate, MAIN_STABLE_SECONDS)
        if not stable:
            log(f"new main pid(s) {candidate} exited during startup")
            if attempt >= attempts:
                result["newMainPids"] = candidate
                result["newHostPids"] = []
                result["page"] = {"ok": False, "url": None, "version": None}
                result["status"] = "failed"
                result["error"] = "the relaunched app exited before creating a desktop host"
                result["elapsedSeconds"] = round(time.monotonic() - started, 2)
                write_result(result_path, result)
                return 1
            log(f"retrying launch in {args.settle:g}s")
            time.sleep(args.settle)
            launch_app(app)
            continue

        new_main = stable
        new_hosts = wait_new_host(new_main, args.ready_timeout)
        if new_hosts:
            break

        log(f"desktop host did not start for main {new_main}; trying activate")
        activate_app(name)
        new_hosts = wait_new_host(new_main, min(10.0, args.ready_timeout))
        if new_hosts:
            break

        if attempt >= attempts:
            break
        log("relaunching after host startup failure")
        quit_app(new_main, name, args.timeout, args.force)
        remaining = [pid for pid in host_pids_for(new_main) if pid_exists(pid)]
        if remaining:
            terminate_processes(remaining, timeout=min(10.0, args.timeout), force=args.force, label="desktop host")
        remaining_helpers = [pid for pid in app_process_pids(app) if pid_exists(pid)]
        if remaining_helpers:
            terminate_processes(
                remaining_helpers,
                timeout=min(10.0, args.timeout),
                force=args.force,
                label="app helpers",
            )
        seen.update(new_main)
        time.sleep(args.settle)
        launch_app(app)

    result["newMainPids"] = new_main
    result["newHostPids"] = new_hosts
    if new_hosts:
        activate_app(name)
    log(f"new desktop host pid(s): {new_hosts}")

    probe = wait_for_page(new_hosts, args.ready_timeout)
    result["page"] = probe
    result["elapsedSeconds"] = round(time.monotonic() - started, 2)
    if probe.get("ok"):
        result["status"] = "ok"
        log(f"restart OK; page={probe.get('url')} version={probe.get('version')} bytes={probe.get('bytes')}")
    else:
        result["status"] = "started-unverified"
        result["error"] = "app launched but /hybrid-workspace/ was not verified"
        log(f"restart launched, but page verification failed: {probe}")
    write_result(result_path, result)
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Restart the DeepSeek Harness desktop app and verify the management page.",
    )
    parser.add_argument("--app", default=os.environ.get("DSH_APP", str(DEFAULT_APP)))
    parser.add_argument("--delay", type=float, default=3.0, help="seconds to wait before quitting (detached mode)")
    parser.add_argument("--timeout", type=float, default=30.0, help="seconds to wait for the old app to exit")
    parser.add_argument("--ready-timeout", type=float, default=30.0, help="seconds to wait for the new app/page")
    parser.add_argument("--settle", type=float, default=3.0, help="seconds to wait after the old app exits")
    parser.add_argument("--attempts", type=int, default=2, help="launch attempts when the first process exits early")
    parser.add_argument("--force", action="store_true", help="SIGKILL if graceful quit times out")
    parser.add_argument("--detach", action="store_true", help="return immediately and restart in the background")
    parser.add_argument("--dry-run", action="store_true", help="show the plan without touching the app")
    parser.add_argument("--check", action="store_true", help="print detected app PIDs and exit")
    parser.add_argument("--log", default=str(DEFAULT_LOG), help=argparse.SUPPRESS)
    parser.add_argument("--result", default=str(DEFAULT_RESULT), help=argparse.SUPPRESS)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.settle < 0:
        parser.error("--settle must be zero or greater")
    if args.attempts < 1:
        parser.error("--attempts must be at least 1")

    app = Path(args.app).expanduser()
    if not app.is_absolute():
        app = (Path.cwd() / app).resolve()

    if args.check:
        return check(app)
    if args.detach:
        if args.dry_run:
            parser.error("--detach cannot be combined with --dry-run")
        return schedule(args, app)

    try:
        if args.worker:
            log(f"restart worker pid={os.getpid()} delay={args.delay:g}s")
            if args.delay > 0:
                time.sleep(args.delay)
        return restart(args, app, Path(args.result).expanduser())
    except Exception as exc:
        log(f"RESTART FAILED: {exc}")
        write_result(
            Path(args.result).expanduser(),
            {"status": "failed", "app": str(app), "error": str(exc)},
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
