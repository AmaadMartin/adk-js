# GCP Skill Registry sample

An agent that discovers and loads skills from the GCP Skill Registry instead of
from a local directory. `SkillToolset` starts with no skills, so every skill the
agent uses comes from the registry at run time.

## Prerequisites

The registry calls the Agent Registry API, so it needs a project, a location and
credentials:

```bash
export GOOGLE_CLOUD_PROJECT=<your-project>
export GOOGLE_CLOUD_LOCATION=<your-location>
gcloud auth application-default login
```

`GCPSkillRegistry` throws in its constructor when neither the options nor the
environment name a project and a location. This sample builds one when the
module loads, so both variables must be set before you run it.

The agent calls a live model, so set `GEMINI_API_KEY` as well.

## Running

```bash
npm run build   # builds @google/adk and the CLI; needed once, and after changes
npm run sample -- samples/skills/gcp_skill_registry/agent.ts
```

The CLI is interactive. Ask for a task that a skill in your catalogue covers,
and the agent calls `search_skills` and then `load_skill`. Type `exit` to quit.

## See also

[The GCPSkillRegistry guide](../../../docs/guides/skills/gcp_skill_registry/index.md)
covers the credential options, the `AGENT_REGISTRY_ENDPOINT` override and
mutual TLS.
