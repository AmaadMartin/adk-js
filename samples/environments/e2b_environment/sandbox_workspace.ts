/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A remote sandbox workspace, driven by `E2BEnvironment`.
 *
 * This is the manual end-to-end test for the class: it drives a real E2B
 * sandbox with nothing mocked. It installs a package, writes a script, runs
 * the script, reads the file the script produced, and then exercises the two
 * error paths that are results rather than throws. It kills the sandbox on
 * every exit path.
 *
 * Running it costs E2B credits. See the README next to this file.
 */

import {E2BEnvironment} from '@google/adk';

/** Sandbox time-to-live. Every operation resets it. */
const TIMEOUT_SECONDS = 300;

/** Command timeouts, in seconds. Installing is slower than running. */
const INSTALL_TIMEOUT_SECONDS = 120;
const RUN_TIMEOUT_SECONDS = 60;

/**
 * Writes the installed `requests` version to a file next to itself, proving
 * both that the install landed and that a relative path resolves against the
 * sandbox home.
 */
const REPORT_SCRIPT = `import requests

with open('report.txt', 'w') as handle:
    handle.write(requests.__version__)
print('wrote report.txt')
`;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  if (!process.env.E2B_API_KEY) {
    console.error('E2B_API_KEY is not set. Get a key at https://e2b.dev.');
    process.exitCode = 1;
    return;
  }

  const env = new E2BEnvironment({timeoutSeconds: TIMEOUT_SECONDS});
  await env.initialize();
  try {
    console.log(`working dir: ${env.workingDir}`);

    const install = await env.execute(
      'pip install requests',
      INSTALL_TIMEOUT_SECONDS,
    );
    console.log(`pip install requests: exit ${install.exitCode}`);

    await env.writeFile('report.py', REPORT_SCRIPT);
    const run = await env.execute('python report.py', RUN_TIMEOUT_SECONDS);
    console.log(`python report.py: exit ${run.exitCode}, ${run.stdout.trim()}`);

    const report = await env.readFile('report.txt');
    console.log(`requests version: ${new TextDecoder().decode(report)}`);

    // A non-zero exit code is a result, not a thrown error.
    const failed = await env.execute('exit 3', RUN_TIMEOUT_SECONDS);
    console.log(
      `exit 3: exitCode ${failed.exitCode}, timedOut ${failed.timedOut}`,
    );

    try {
      await env.readFile('missing.txt');
      console.error('readFile should have thrown for a missing file');
      process.exitCode = 1;
    } catch (error: unknown) {
      console.log(`missing.txt: ${describeError(error)}`);
    }
  } finally {
    await env.close();
    console.log('sandbox killed');
  }
}

await main();
