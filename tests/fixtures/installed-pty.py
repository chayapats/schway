"""Exercise an installed Schway executable through a real OS pseudo-terminal."""

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def read_for(fd: int, output: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.05)[0]:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
        if len(output) > 1_000_000:
            raise RuntimeError("PTY output exceeded fixture bound")


def read_until(fd: int, output: bytearray, marker: bytes, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while marker not in output and time.monotonic() < deadline:
        read_for(fd, output, 0.1)
    if marker not in output:
        raise RuntimeError("PTY did not display expected installed app marker")


def resize(fd: int, columns: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def main() -> None:
    master, slave = pty.openpty()
    resize(slave, 80, 24)
    output = bytearray()
    process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave,
                               env=dict(os.environ, TERM="xterm-256color"), start_new_session=True)
    os.close(slave)
    try:
        read_until(master, output, b"Type a task", 5)
        os.write(master, b"\x1b[200~" + "ไทย 中文 👩‍💻 é".encode() + b"\x1b[201~")
        read_for(master, output, 0.5)
        draft_output = bytes(output)
        draft_text = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", draft_output).decode(errors="replace")
        if not all(value in draft_text for value in ("ไทย", "中文", "👩‍💻", "é")):
            raise RuntimeError("installed PTY did not display the pasted Unicode draft")
        os.write(master, b"\r")
        read_until(master, output, b"Answer:", 5)
        resize(master, 32, 12)
        os.kill(process.pid, signal.SIGWINCH)
        read_for(master, output, 0.3)
        recovery_start = len(output)
        os.write(master, b"\x0c")
        read_for(master, output, 0.3)
        recovery_output = bytes(output[recovery_start:])
        if b"Ready" not in recovery_output or b"Ask Schway" not in recovery_output:
            raise RuntimeError("Ctrl+L did not restore the narrow installed screen")
        os.write(master, b"\x03")
        read_for(master, output, 0.3)
        if process.poll() is None:
            os.write(master, b"\x03")
            read_for(master, output, 0.3)
        try:
            exit_code = process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            raise RuntimeError("installed PTY fixture did not exit")
        result = {
            "exit": exit_code,
            "thai": "ไทย".encode() in output,
            "cjk": "中文".encode() in output,
            "emoji": "👩‍💻".encode() in output,
            "combining": "é".encode() in output,
            "alternate_enter": b"\x1b[?1049h" in output,
            "alternate_exit": b"\x1b[?1049l" in output,
            "answer": b"Answer:" in output,
            "draft_input": True,
            "narrow_recovery": True,
            "bytes": len(output),
        }
        print(json.dumps(result))
        if exit_code != 0 or not all(result[key] for key in
                                      ("thai", "cjk", "emoji", "combining", "alternate_enter", "alternate_exit", "answer")):
            raise RuntimeError("installed PTY Unicode or cleanup check failed")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        os.close(master)


if __name__ == "__main__":
    main()
