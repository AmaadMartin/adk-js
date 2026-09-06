/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DaytonaEnvironment: a remote sandbox as an agent workspace.
 *
 * Writes a Python script into a Daytona sandbox, runs it there, and reads the
 * file it produced back out. Nothing runs on the host.
 *
 * Prerequisites and the run command are in the README next to this file.
 */

import {DaytonaEnvironment} from '@google/adk';

const SCRIPT = `
import json, pathlib
rows = [{"city": "Lisbon", "people": 545923}, {"city": "Porto", "people": 231962}]
pathlib.Path("report.json").write_text(json.dumps(rows, indent=2))
print(f"wrote {len(rows)} rows")
`;

async function main(): Promise<void> {
  const env = new DaytonaEnvironment({
    timeoutSeconds: 300,
    envVars: {DATASET: 'census'},
  });

  await env.initialize();
  try {
    process.stdout.write(`working directory: ${env.workingDir}\n`);

    await env.writeFile('analyze.py', SCRIPT);
    const result = await env.execute('python analyze.py');
    process.stdout.write(`exit code: ${result.exitCode}\n`);
    process.stdout.write(`stdout: ${result.stdout}`);

    const report = await env.readFile('report.json');
    process.stdout.write(
      `report.json:\n${Buffer.from(report).toString('utf-8')}\n`,
    );
  } finally {
    // Deletes the sandbox. Without it, Daytona stops and deletes the sandbox
    // itself once the auto-stop interval elapses.
    await env.close();
  }
}

await main();
