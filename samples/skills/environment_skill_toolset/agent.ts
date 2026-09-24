/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LlmAgent,
  LocalEnvironment,
  SkillToolset,
  loadSkillFromDir,
} from '@google/adk';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const sampleDir = path.dirname(fileURLToPath(import.meta.url));

const skill = await loadSkillFromDir(path.join(sampleDir, 'word_count'));

// LocalEnvironment runs the model's command on the host with no sandboxing.
// Scope it to a workspace directory rather than the process working directory.
const environment = new LocalEnvironment({
  workingDir: path.join(sampleDir, 'workspace'),
});

export const rootAgent = new LlmAgent({
  name: 'environment_skill_agent',
  description: 'Answers questions about files by running a skill script.',
  model: 'gemini-2.5-flash',
  tools: [new SkillToolset([skill], {environment})],
});
