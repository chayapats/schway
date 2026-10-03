"""Run a CLI with independently selected real stdin/stdout terminal descriptors."""

import argparse
import errno
import json
import os
import pty
import selectors
import signal
import subprocess
import time
import tty


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdin-tty", type=int, choices=(0, 1), required=True)
    parser.add_argument("--stdout-tty", type=int, choices=(0, 1), required=True)
    parser.add_argument("--timeout", type=float, default=8)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    command = options.command[1:] if options.command[:1] == ["--"] else options.command
    if not command:
        parser.error("a command is required")

    def interrupted(_signum, _frame) -> None:
        raise RuntimeError("CLI descriptor fixture interrupted")

    previous = signal.signal(signal.SIGTERM, interrupted)
    master, slave = pty.openpty()
    tty.setraw(slave)  # No echo or newline conversion contaminates captured bytes.
    selector = selectors.DefaultSelector()
    child = None
    output = {"stdout": bytearray(), "stderr": bytearray()}
    try:
        child = subprocess.Popen(
            command, stdin=slave if options.stdin_tty else subprocess.PIPE,
            stdout=slave if options.stdout_tty else subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True,
        )
        os.close(slave)
        slave = None
        selector.register(master if options.stdout_tty else child.stdout,
                          selectors.EVENT_READ, "stdout")
        selector.register(child.stderr, selectors.EVENT_READ, "stderr")
        # Deliberately leave piped stdin open until cleanup. The CLI must decide
        # from its arguments/descriptors without reading a task or waiting for EOF.
        deadline = time.monotonic() + options.timeout
        while selector.get_map() or child.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("CLI did not terminate before its descriptor deadline")
            if not selector.get_map():
                child.wait(timeout=remaining)
                break
            for key, _ in selector.select(min(remaining, 0.05)):
                try:
                    chunk = os.read(key.fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""  # PTYs report EIO when the last slave closes.
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output[key.data].extend(chunk)
                if len(output[key.data]) > 1_000_000:
                    raise RuntimeError("CLI output exceeded fixture bound")
        code = child.wait(timeout=max(0.01, deadline - time.monotonic()))
        print(json.dumps({"exit": code, **{
            name: value.decode("utf-8", errors="strict") for name, value in output.items()
        }}))
    finally:
        # Kill the entire child group even when its leader exited with live
        # descendants. This also unwinds on an outer SIGTERM or a read deadline.
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=2)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream is not None:
                    stream.close()
        selector.close()
        if slave is not None:
            os.close(slave)
        os.close(master)
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    main()
