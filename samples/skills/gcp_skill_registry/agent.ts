/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skills: loading them from the GCP Skill Registry
 *
 * `GCPSkillRegistry` fetches a skill from the Agent Registry API instead of
 * from a local directory. `SkillToolset` starts with no skills and asks the
 * registry, so the agent discovers the catalogue at run time.
 *
 * The registry reads `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, or
 * takes them as options. It resolves application default credentials on the
 * first request, so `gcloud auth application-default login` is enough.
 *
 * Run:
 *   npm run sample -- samples/skills/gcp_skill_registry/agent.ts
 */

import {GCPSkillRegistry, LlmAgent, SkillToolset} from '@google/adk';

const registry = new GCPSkillRegistry();

export const rootAgent = new LlmAgent({
  name: 'skill_registry_agent',
  model: 'gemini-flash-latest',
  description:
    'An agent that can discover and load skills from the GCP Skill Registry.',
  instruction:
    'Use search_skills to find skills, and load_skill to load one you need.',
  tools: [new SkillToolset([], {registry})],
});
