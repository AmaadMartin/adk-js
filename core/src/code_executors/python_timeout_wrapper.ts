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
 * It is invoked as `python3 -c <wrapper> <seconds> <command> [args...]`. It
 * forks the command into its own process group and waits for it. When the bound
 * expires it sends `SIGKILL` to the whole group and exits with
 * {@link TIMEOUT_EXIT_CODE}. It sweeps the group again once the command ends on
 * its own, so nothing the command started stays alive in the shared container.
 *
 * Two properties matter for code that may be hostile. The deadline lives in a
 * process the executed code never runs in, so the code cannot disarm it. The
 * `SIGKILL` goes to the process group, so it reaches what the code spawned and
 * not only its top frame.
 *
 * The supervisor is written in Python because `python3` is the one interpreter
 * the executor verifies at container start. It runs only inside the container.
 *
 * Limitation: code that leaves the group on purpose (`os.setsid()`) or
 * double-forks away outlives the bound until the container is torn down.
 */
export const PYTHON_TIMEOUT_WRAPPER = `import os, signal, sys

_timeout = int(sys.argv[1])
_argv = sys.argv[2:]

_pid = os.fork()
if _pid == 0:
  try:
    os.setpgid(0, 0)
  except OSError:
    pass
  os.execvp(_argv[0], _argv)
else:

  def _sweep_group():
    try:
      os.killpg(_pid, signal.SIGKILL)
    except OSError:
      pass

  def _expire(_signum, _frame):
    _sweep_group()
    try:
      os.kill(_pid, signal.SIGKILL)
    except OSError:
      pass
    os._exit(${TIMEOUT_EXIT_CODE})

  try:
    os.setpgid(_pid, _pid)
  except OSError:
    pass
  signal.signal(signal.SIGALRM, _expire)
  signal.alarm(_timeout)
  _status = os.waitpid(_pid, 0)[1]
  signal.alarm(0)
  _sweep_group()
  os._exit(
      128 + os.WTERMSIG(_status)
      if os.WIFSIGNALED(_status)
      else os.WEXITSTATUS(_status)
  )
`;
