/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ReadFileTool
 *
 * Gives an agent a file it can read without running `cat` through the
 * environment's shell. The tool takes a path plus an optional 1-based line
 * range, and returns the content with a line number in front of every line.
 *
 * The environment below is a temporary directory holding one file. Ask the
 * agent something like "read lines 2 to 4 of notes.txt".
 *
 * Run (needs a model API key):
 *   npm run sample -- samples/tools/read_file_tool/agent.ts
 */

import {LlmAgent, LocalEnvironment, ReadFileTool} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-read-file-'));
const environment = new LocalEnvironment({workingDir});
await environment.initialize();
await environment.writeFile(
  'notes.txt',
  [
    'Shopping list',
    '- coffee',
    '- oat milk',
    '- a new kettle',
    'End of list',
  ].join('\n'),
);

export const rootAgent = new LlmAgent({
  name: 'file_reader',
  model: 'gemini-flash-latest',
  description: 'Answers questions about the files in its environment.',
  instruction:
    'Use the ReadFile tool to read files before answering. The environment ' +
    'contains notes.txt. Quote the line numbers the tool returns.',
  tools: [new ReadFileTool(environment)],
});
