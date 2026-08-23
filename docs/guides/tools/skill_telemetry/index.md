# Skill telemetry

Records which skill an agent loaded, and where that skill came from, as
attributes on the OpenTelemetry span of the tool call. Reach for it when you
run an agent with a `SkillToolset` and need to see skill usage in a tracing
backend.

## Introduction

`SkillToolset` gives a model two tools for reading a skill: `load_skill` reads
the instructions, and `load_skill_resource` reads one file inside the skill.
Both run inside an `execute_tool <tool name>` span that ADK already opens for
every tool call. That span names the tool but not the skill, so a trace shows
that the agent read _a_ skill without saying which one.

Skill telemetry closes that gap. It adds `adk.experimental.skill.*` attributes
to the existing span. It creates no span of its own, adds no metric, and
changes nothing about what the tools return. The attribute names match the ones
adk-python emits, so one dashboard reads both SDKs.

These attributes are experimental. The `adk.experimental.` prefix carries no
compatibility guarantee: an attribute may be renamed, restructured, or removed
in any release.

## Get started

Configure a tracer provider, then run the agent as usual. The attributes appear
on the tool span with no further setup.

```ts
import {
  LlmAgent,
  SkillToolset,
  loadAllSkillsInDir,
  maybeSetOtelProviders,
} from '@google/adk';
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

maybeSetOtelProviders([
  {spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())]},
]);

const agent = new LlmAgent({
  name: 'skilled_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Load a skill before you answer.',
  tools: [new SkillToolset(await loadAllSkillsInDir('./skills'))],
});
```

When the model calls `load_skill`, the exported `execute_tool load_skill` span
carries:

```
gen_ai.operation.name                   = "execute_tool"
gen_ai.tool.name                        = "load_skill"
adk.experimental.skill.name             = "pdf-processing"
adk.experimental.skill.description      = "Extract text and tables from PDFs"
adk.experimental.skill.source.uri       = "file:///home/u/skills/pdf-processing"
adk.experimental.skill.additional_tools = ["read_file", "write_file"]
```

## Attributes

| Attribute                                 | Written by            | Value                                                                                    |
| ----------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `adk.experimental.skill.name`             | both tools            | The skill name the model asked for.                                                      |
| `adk.experimental.skill.description`      | `load_skill`          | `frontmatter.description` of the loaded skill.                                           |
| `adk.experimental.skill.source.uri`       | both tools            | `Skill.uri`, omitted when the skill has none.                                            |
| `adk.experimental.skill.additional_tools` | `load_skill`          | The `adk_additional_tools` frontmatter metadata, omitted unless it is a list of strings. |
| `adk.experimental.skill.resource.path`    | `load_skill_resource` | The resource path the model asked for.                                                   |

A resource load records no description and no additional tools. This matches
adk-python.

## Where the source uri comes from

`loadSkillFromDir` and `loadAllSkillsInDir` set `Skill.uri` to the `file://`
URL of the skill directory. `loadSkillFromZipBuffer` and `GCPSkillRegistry`
leave it undefined, because a skill delivered as a zip payload has no directory
to name. The attribute is then absent rather than wrong.

You can also set `uri` yourself on a `Skill` you build in code:

```ts
const skill: Skill = {
  frontmatter: {name: 'pdf-processing', description: 'Extract text from PDFs'},
  instructions: 'Use pdftotext.',
  uri: 'https://example.com/skills/pdf-processing',
};
```

## Failure paths

A tool call that fails still records the attempt. The rule is that the always-
known values are recorded, and the skill-derived ones are not:

| Outcome                                                                                   | Recorded                                                                                            |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The `name` or `path` argument is missing                                                  | Nothing. The tool returns before it reads any skill.                                                |
| The registry throws (`REGISTRY_ERROR`)                                                    | The skill name, plus the resource path for `load_skill_resource`.                                   |
| The skill is unknown (`SKILL_NOT_FOUND`)                                                  | The same.                                                                                           |
| The resource path is rejected (`INVALID_RESOURCE_PATH`) or missing (`RESOURCE_NOT_FOUND`) | The skill name, the resource path, and the source uri. The skill loaded; only the resource did not. |

The failure itself is not duplicated into a skill attribute. It belongs to the
tool result the model receives.
