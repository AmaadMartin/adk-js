/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawnSync} from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  PYTHON_RUNNER_SOURCE,
  pythonChildEnv,
  pythonRunName,
} from '../../src/code_executors/python_runner.js';

const PYTHON_COMMAND = os.platform() === 'win32' ? 'python' : 'python3';

describe('pythonRunName', () => {
  it.each([
    "if __name__ == '__main__':\n  print('hi')",
    'if __name__ == "__main__":\n  print("hi")',
    'if __name__=="__main__":\n  print("hi")',
    "if   __name__   ==   '__main__' :\n  print('hi')",
  ])('returns __main__ for a guarded program %j', (code) => {
    expect(pythonRunName(code)).toBe('__main__');
  });

  it.each([
    "print('hi')",
    "print('this mentions __main__ in a string')",
    'name = "__main__"',
  ])('returns the empty string for an unguarded program %j', (code) => {
    expect(pythonRunName(code)).toBe('');
  });
});

describe('pythonChildEnv', () => {
  it('pins the output encoding to utf-8', () => {
    expect(pythonChildEnv().PYTHONIOENCODING).toBe('utf-8');
  });

  it('puts the working directory first on the import path', () => {
    const {PYTHONPATH} = process.env;
    try {
      delete process.env.PYTHONPATH;

      expect(pythonChildEnv().PYTHONPATH).toBe(process.cwd());
    } finally {
      if (PYTHONPATH === undefined) {
        delete process.env.PYTHONPATH;
      } else {
        process.env.PYTHONPATH = PYTHONPATH;
      }
    }
  });

  it('keeps an import path the host already set, after the working directory', () => {
    const original = process.env.PYTHONPATH;
    try {
      process.env.PYTHONPATH = '/host/one';

      expect(pythonChildEnv().PYTHONPATH).toBe(
        `${process.cwd()}${path.delimiter}/host/one`,
      );
    } finally {
      if (original === undefined) {
        delete process.env.PYTHONPATH;
      } else {
        process.env.PYTHONPATH = original;
      }
    }
  });

  it('passes the rest of the parent environment through', () => {
    expect(pythonChildEnv().PATH).toBe(process.env.PATH);
  });

  it('does not modify process.env', () => {
    const before = {...process.env};

    pythonChildEnv();

    expect({...process.env}).toEqual(before);
  });
});

describe('PYTHON_RUNNER_SOURCE', () => {
  it("leaves the caller's own arguments in sys.argv", () => {
    const result = spawnSync(
      PYTHON_COMMAND,
      ['-c', PYTHON_RUNNER_SOURCE, '', 'alpha', 'beta'],
      {input: 'import sys\nprint(sys.argv[1:])', encoding: 'utf-8'},
    );

    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe("['alpha', 'beta']");
  });

  it('runs the program under the run name it is given', () => {
    const result = spawnSync(
      PYTHON_COMMAND,
      ['-c', PYTHON_RUNNER_SOURCE, '__main__'],
      {input: "print(globals().get('__name__'))", encoding: 'utf-8'},
    );

    expect(result.stdout.trim()).toBe('__main__');
  });

  it('leaves __name__ unset when the run name is empty', () => {
    const result = spawnSync(PYTHON_COMMAND, ['-c', PYTHON_RUNNER_SOURCE, ''], {
      input: "print(globals().get('__name__'))",
      encoding: 'utf-8',
    });

    expect(result.stdout.trim()).toBe('None');
  });

  it('reports an escaping exception as status 1 without its own frame', () => {
    const result = spawnSync(PYTHON_COMMAND, ['-c', PYTHON_RUNNER_SOURCE, ''], {
      input: 'raise ValueError("boom")',
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ValueError: boom');
    expect(result.stderr).not.toContain('exec(compile(');
  });

  it("lets the program's own exit status stand", () => {
    const result = spawnSync(PYTHON_COMMAND, ['-c', PYTHON_RUNNER_SOURCE, ''], {
      input: 'import sys\nsys.exit(7)',
      encoding: 'utf-8',
    });

    expect(result.status).toBe(7);
    expect(result.stderr).toBe('');
  });
});
