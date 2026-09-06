/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  pythonChildEnv,
  pythonRunName,
} from '@google/adk/code_executors/python_runner.js';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

describe('pythonRunName', () => {
  it.each([
    "if __name__ == '__main__':\n  print('hi')",
    'if __name__ == "__main__":\n  print("hi")',
    "if   __name__=='__main__' :\n  pass",
    "def main():\n  pass\n\nif __name__ == '__main__':\n  main()",
  ])('gives a guarded program the __main__ name: %j', (code) => {
    expect(pythonRunName(code)).toBe('__main__');
  });

  it.each([
    "print('hi')",
    '',
    "print('__main__')",
    "name = '__main__'\nprint(name)",
  ])('leaves an unguarded program without a name: %j', (code) => {
    expect(pythonRunName(code)).toBe('');
  });
});

describe('pythonChildEnv', () => {
  const inheritedPythonPath = process.env.PYTHONPATH;

  afterEach(() => {
    if (inheritedPythonPath === undefined) {
      delete process.env.PYTHONPATH;
    } else {
      process.env.PYTHONPATH = inheritedPythonPath;
    }
  });

  it('pins the output encoding', () => {
    expect(pythonChildEnv().PYTHONIOENCODING).toBe('utf-8');
  });

  it('puts the agent directory first on the import path', () => {
    delete process.env.PYTHONPATH;

    expect(pythonChildEnv().PYTHONPATH).toBe(process.cwd());
  });

  it('keeps an inherited import path after the agent directory', () => {
    process.env.PYTHONPATH = '/inherited/first';

    expect(pythonChildEnv().PYTHONPATH).toBe(
      `${process.cwd()}${path.delimiter}/inherited/first`,
    );
  });

  it('leaves the parent environment alone', () => {
    delete process.env.PYTHONPATH;
    const before = {...process.env};

    pythonChildEnv();

    expect(process.env).toEqual(before);
    expect(process.env.PYTHONPATH).toBeUndefined();
  });
});
