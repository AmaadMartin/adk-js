/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reported by the supervisor when it kills a run that hit the bound. It follows
 * the convention of coreutils `timeout`. Unlike `128 + SIGALRM`, the executed
 * code cannot produce it by letting an alarm of its own fire.
 */
export const TIMEOUT_EXIT_CODE = 124;

/**
 * A Python supervisor that puts a hard wall-clock bound on another command
 * inside the container.
 *
 * It is invoked as `python3 -c <wrapper> <seconds> <command> [args...]`. The
 * command runs in a session of its own and the supervisor waits for it. When
 * the bound expires the supervisor sends `SIGKILL` to the whole process group
 * and exits with {@link TIMEOUT_EXIT_CODE}. It sweeps the group again once the
 * command ends on its own, so nothing the command started stays alive in the
 * shared container. A leftover process would also hold the exec's output open.
 *
 * Two properties matter for code that may be hostile. The deadline lives in a
 * process the executed code never runs in, so the code cannot disarm it. The
 * `SIGKILL` goes to the process group, so it reaches what the code spawned and
 * not only its top frame.
 *
 * The command is executed rather than read, so the real interpreter sets
 * `sys.argv` and reports traceback line numbers.
 *
 * Limitation: code that leaves the group on purpose (`os.setsid()`) or
 * double-forks away outlives the bound until the container is torn down.
 */
export const PYTHON_TIMEOUT_WRAPPER = `import os, signal, subprocess, sys

_child = subprocess.Popen(sys.argv[2:], start_new_session=True)
try:
  _status = _child.wait(int(sys.argv[1]))
  _code = 128 - _status if _status < 0 else _status
except subprocess.TimeoutExpired:
  _code = ${TIMEOUT_EXIT_CODE}

try:
  os.killpg(_child.pid, signal.SIGKILL)
except OSError:
  pass
os._exit(_code)
`;
