/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Variables `os.homedir()` reads. POSIX reads `HOME`; Windows reads
 * `USERPROFILE`. Both are set so a test redirects the home directory on either
 * platform without mocking the module.
 */
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'];

/**
 * A temporary home directory, so a test that reads `~/.adk/config.json` never
 * touches the real one.
 */
export class TempHome {
  private readonly saved = new Map<string, string | undefined>();
  private directory?: string;

  /** Creates the directory and points `os.homedir()` at it. */
  create(): string {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-home-'));
    for (const name of HOME_ENV_VARS) {
      this.saved.set(name, process.env[name]);
      process.env[name] = this.directory;
    }

    return this.directory;
  }

  /** Writes the ADK global config file under the temporary home. */
  writeAdkConfig(contents: string): void {
    const configPath = path.join(os.homedir(), '.adk', 'config.json');
    fs.mkdirSync(path.dirname(configPath), {recursive: true});
    fs.writeFileSync(configPath, contents, 'utf-8');
  }

  /** Restores the environment and removes the directory. */
  remove(): void {
    for (const [name, value] of this.saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    this.saved.clear();
    if (this.directory) {
      fs.rmSync(this.directory, {recursive: true, force: true});
      this.directory = undefined;
    }
  }
}
