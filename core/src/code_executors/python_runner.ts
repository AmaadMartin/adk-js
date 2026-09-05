/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

/**
 * Matches a program that asks to run as `__main__`.
 */
const MAIN_GUARD_PATTERN = /if\s+__name__\s*==\s*['"]__main__['"]/;

/**
 * Runs one program in the child interpreter.
 *
 * The program arrives on stdin rather than in argv because a single argument
 * is capped (at 128 KiB on Linux) and generated programs can carry their own
 * data. Reading it leaves stdin at end-of-file, which is what the program
 * would have seen before.
 *
 * The traceback is printed here, without the frame this wrapper contributes,
 * so that a failure shows the model its own code and not a file inside this
 * package -- a frame it can do nothing about, which then stays in the
 * conversation for every later request.
 */
export const PYTHON_RUNNER_SOURCE = `
import sys, traceback

_run_name = sys.argv[1]
# Only the run name is dropped, so arguments the caller passed stay in argv.
del sys.argv[1:2]

_globals = {'__name__': _run_name} if _run_name else {}
_source = sys.stdin.buffer.read().decode('utf-8')

try:
  exec(compile(_source, '<code>', 'exec'), _globals, _globals)
except SystemExit:
  # The program chose its own exit status, so let it stand rather than
  # reporting a deliberate clean exit as a failure.
  raise
except BaseException as exc:
  _tb = exc.__traceback__
  traceback.print_exception(
      type(exc), exc, _tb.tb_next if _tb else None, file=sys.stderr
  )
  sys.exit(1)
`;

/**
 * Returns the `__name__` the code should run under, or `''` for none.
 */
export function pythonRunName(code: string): string {
  return MAIN_GUARD_PATTERN.test(code) ? '__main__' : '';
}

/**
 * Returns the environment the child interpreter runs with.
 *
 * `process.env` itself is never modified.
 */
export function pythonChildEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    // The child runs in a scratch cwd, so the application's own directory --
    // which its imports resolved against before -- has to be passed along.
    PYTHONPATH: [process.cwd(), process.env.PYTHONPATH]
      .filter(Boolean)
      .join(path.delimiter),
    // stdout is a pipe, so the child would otherwise encode with the host
    // locale and a program printing non-ASCII would die on its own output.
    PYTHONIOENCODING: 'utf-8',
  };
}
