/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Points `os.homedir()` at `dir` so a test never reads or writes the real
 * user's `~/.adk`. `HOME` covers POSIX and `USERPROFILE` covers Windows.
 *
 * @param dir The directory to use as the home directory.
 * @returns A function that puts both variables back as they were.
 */
export function setHomeDir(dir: string): () => void {
  const home = process.env.HOME;
  const userProfile = process.env.USERPROFILE;

  process.env.HOME = dir;
  process.env.USERPROFILE = dir;

  return () => {
    restoreEnv('HOME', home);
    restoreEnv('USERPROFILE', userProfile);
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
