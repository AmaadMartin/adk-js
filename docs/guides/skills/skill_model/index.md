# Frontmatter, Resources and Skill

A skill is a `SKILL.md` file plus the `references/`, `assets/` and `scripts/`
folders beside it. The loader turns that directory into a `Skill`, and the
`Frontmatter` schema decides which directories are valid skills. Reach for this
page when you author a skill, or when you read a skill's resources from a tool.

## Introduction

A skill has three layers. The frontmatter of `SKILL.md` is L1: the name and
description a model reads to decide whether the skill applies. The markdown body
is L2: the instructions, loaded once the skill is triggered. The three resource
folders are L3: reference documents, assets and scripts, loaded only when a tool
asks for them.

`loadSkillFromDir` validates the frontmatter as it loads. Validation is strict
because the name is also a path segment and a lookup key: `SkillToolset` finds a
skill by name, and the loader checks the name against the directory it came
from. A name the schema rejects fails the load with the reason, rather than
producing a skill nothing can address.

The `Skill`, `Resources` and `Script` types are plain interfaces, so you build
them with object literals and read them with the accessor functions below. There
are no methods to call.

## Get started

```ts
import {getReference, listScripts, loadSkillFromDir} from '@google/adk';

const skill = await loadSkillFromDir('./skills/algorithmic-art');

// 'algorithmic-art', from the `name:` field of SKILL.md.
const name = skill.frontmatter.name;

// The contents of references/style.md, or undefined if there is no such file.
const style = getReference(skill.resources, 'style.md');

// The file names under scripts/, in the order the loader read them.
const scripts = listScripts(skill.resources);
```

## Skill names

A name must be lowercase kebab-case: `a-z`, `0-9` and hyphens, with no leading,
trailing or consecutive hyphen. `my-skill` and `skill` are valid; `My-Skill`,
`-my-skill` and `my--skill` are not. A name is limited to 64 characters, and a
description to 1024.

`snake_case` names are rejected by default. Turn them on with the
`SNAKE_CASE_SKILL_NAME` feature, either through the environment:

```sh
export ADK_ENABLE_SNAKE_CASE_SKILL_NAME=1
```

or in code, before you load any skill:

```ts
import {FeatureName, overrideFeatureEnabled} from '@google/adk';

overrideFeatureEnabled(FeatureName.SNAKE_CASE_SKILL_NAME, true);
```

The flag is read on every parse, so a change takes effect on the next load.
Mixing the two delimiters is rejected either way: `my-skill_1` never validates.

Names are normalized to Unicode NFKC before they are measured and matched. A
full-width `ｍｙ－ｓｋｉｌｌ` validates and loads as `my-skill`, and the
normalized form is what `skill.frontmatter.name` returns. Normalization can
change a name's length, so a name of 33 `ﬁ` ligatures is 66 characters after
folding and is rejected as too long.

## Metadata

`metadata` holds client-specific keys and accepts anything by default. Two keys
are checked:

- `adk_additional_tools` must be an array of strings.
- `adk_inject_state` must be a boolean.

## Reading resources

Each resource folder is a map from file name to content, and each has a getter
and a lister. The getters return `undefined` when the file is absent; the
listers return an empty array. All of them accept an undefined `Resources`, so a
skill with no resources needs no guard at the call site.

```ts
import {
  getAsset,
  getReference,
  getScript,
  listAssets,
  listReferences,
  listScripts,
  scriptToString,
} from '@google/adk';

const schema = getAsset(skill.resources, 'db-schema.sql');
const doc = getReference(skill.resources, 'workflow.md');
const script = getScript(skill.resources, 'render.js');
const source = script ? scriptToString(script) : undefined;

const names = [
  ...listReferences(skill.resources),
  ...listAssets(skill.resources),
  ...listScripts(skill.resources),
];
```

A reference or asset is a `string` when the file is UTF-8 and a `Buffer` when it
is not, so narrow with `Buffer.isBuffer` before you treat it as text. A script
is a `Script`, and `scriptToString` returns its source.

`getSkillName(skill)` and `getSkillDescription(skill)` read the two frontmatter
fields a caller needs most often.

## Where a skill came from

`loadSkillFromDir` sets `skill.uri` to the `file://` URL of the directory it
resolved, which is useful for telemetry and for error messages that must name
the source. `loadSkillFromZipBuffer` leaves `uri` undefined, because an
in-memory archive has no location to record.

```ts
const fromDisk = await loadSkillFromDir('./skills/algorithmic-art');
// 'file:///abs/path/to/skills/algorithmic-art'
const uri = fromDisk.uri;
```
