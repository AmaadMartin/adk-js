# Implementation Plan: ADK JS Skills Registry

## Context

### Task

Implement the Skills Registry feature from `adk-python` into `adk-js`. This is a cross-language parity task to allow JavaScript/TypeScript clients to fetch, search, and load agent skills dynamically from Google Cloud (Vertex AI) Skill Registry.

### ADK Context

The ADK (Agent Development Kit) allows orchestrating agents with tools, memories, and skills. Skills are modular packages containing instructions (`SKILL.md`), references, assets, and executable scripts.

### Language Specific Context

- **Target Language**: TypeScript/ESM (running in Node.js >= 20.0.0).
- **HTTP Client**: Standard `fetch` API.
- **Authentication**: `google-auth-library` to fetch Application Default Credentials (ADC) with the `https://www.googleapis.com/auth/cloud-platform` scope.
- **Compression**: In-memory zip file extraction using `jszip`.
- **Testing Framework**: Vitest.

---

## Data Models

### 1. `SkillRegistry` Interface

Defined in [core/src/skills/skill_registry.ts](file:///usr/local/google/home/amaadmartin/Workspace/Elaborationspaces/elab-implement-skills-reg-47643b/repos/adk-js/core/src/skills/skill_registry.ts):

```typescript
import {Frontmatter, Skill} from './skill.js';

export interface SkillRegistry {
  /**
   * Fetches a skill from the registry.
   *
   * @param name The name of the skill.
   * @returns A promise that resolves to the Skill object.
   * @throws {Error} If the skill with the specified name does not exist or fails validation.
   */
  getSkill(name: string): Promise<Skill>;

  /**
   * Searches for skills in the registry.
   *
   * @param query The search query.
   * @returns A promise that resolves to a list of Frontmatter objects for discovery.
   */
  searchSkills(query: string): Promise<Frontmatter[]>;

  /**
   * Returns the description for the search_skills tool.
   *
   * Registries can define this to provide specialized instructions to the model
   * on how to use their specific search capabilities.
   */
  searchToolDescription?(): string | null;
}
```

---

## Function Definitions

### 1. `loadSkillFromZipBytes(zipBytes: Buffer): Promise<Skill>`

Defined in [core/src/skills/zip_loader.ts](file:///usr/local/google/home/amaadmartin/Workspace/Elaborationspaces/elab-implement-skills-reg-47643b/repos/adk-js/core/src/skills/zip_loader.ts):
Loads and parses a zipped skill archive directly from a buffer.

#### Inputs

- `zipBytes`: A `Buffer` containing raw bytes of the zip archive.

#### Outputs

- `Promise<Skill>`: A fully populated `Skill` object containing parsed frontmatter metadata, markdown body instructions, and resource assets/references/scripts.

#### Side Effects

- CPU-intensive in-memory unzip operations. No filesystem access.

---

### 2. `GCPSkillRegistry` Class

Defined in [core/src/integrations/skill_registry/gcp_skill_registry.ts](file:///usr/local/google/home/amaadmartin/Workspace/Elaborationspaces/elab-implement-skills-reg-47643b/repos/adk-js/core/src/integrations/skill_registry/gcp_skill_registry.ts):
Implements `SkillRegistry` for Vertex AI Skills API.

#### Inputs

- `options.projectId` (optional): GCP Project ID. Fallback to `process.env.GOOGLE_CLOUD_PROJECT`.
- `options.location` (optional): GCP Location. Fallback to `process.env.GOOGLE_CLOUD_LOCATION` or `'us-central1'`.

#### Methods

- `getSkill(name: string): Promise<Skill>`:
  - Hits GET `https://{location}-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{location}/skills/{name}`.
  - Extracts the base64-encoded `zippedFilesystem` from response, decodes to Buffer, and calls `loadSkillFromZipBytes`.
- `searchSkills(query: string): Promise<Frontmatter[]>`:
  - Hits GET `https://{location}-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{location}/skills:retrieve?query={query}`.
  - Extracts lists of retrieved skills and maps them to `Frontmatter` models.

#### Side Effects

- Executing Google Application Default Credentials request.
- Makes outbound HTTPS requests to the Vertex AI API endpoint.

---

## Constraints

### Invariants

- **Zip Slip Prevention**: During unzipping, throw an error if any entry name starts with `/`, `../`, or contains `/../`.
- **Skill Name Validation**: The skill name defined in `SKILL.md` frontmatter must match the skill ID requested.
- **Strict Format Constraints**: Frontmatter schema must validate against the zod-based `FrontmatterSchema` (e.g. name length <= 64, description length <= 1024).

### Error Handling Protocols

- **API Failures**: If HTTP request is not successful (status !== 200), bubble a detailed error with the HTTP status and response body payload.
- **Authentication Failures**: Throws clear error messages if resolving application credentials fails.
- **Empty Filesystems**: Throw `ValueError` (as standard Error) if a skill resource does not contain `zippedFilesystem`.

### Breaking Change Analysis

- This change introduces new exports (`SkillRegistry`, `GCPSkillRegistry`, `loadSkillFromZipBytes`) without changing existing APIs. It is non-breaking.

---

## Testing

### Unit Tests

A minimum of 95% New Line Coverage is expected for all added code.

#### 1. Zip Loader Tests

Defined in [core/test/skills/zip_loader_test.ts](file:///usr/local/google/home/amaadmartin/Workspace/Elaborationspaces/elab-implement-skills-reg-47643b/repos/adk-js/core/test/skills/zip_loader_test.ts):

- Test successful unzip of valid skill content.
- Test Zip Slip vulnerability handling (throws error on `../` filenames).
- Test validation failures when `SKILL.md` frontmatter is malformed.
- Test fallback when skill file is nested in single subfolder inside zip.

#### 2. GCP Skill Registry Tests

Defined in [core/test/integrations/gcp_skill_registry_test.ts](file:///usr/local/google/home/amaadmartin/Workspace/Elaborationspaces/elab-implement-skills-reg-47643b/repos/adk-js/core/test/integrations/gcp_skill_registry_test.ts):

- Mock `google-auth-library` to stub token exchange.
- Mock `global.fetch` to return stubbed JSON responses for GET skill and GET retrieve.
- Verify `getSkill` parses correct resource path and invokes unzipping utility.
- Verify `searchSkills` correctly extracts matched results and parses names/descriptions.
- Verify auth token refresh errors and API HTTP failures are propagated cleanly.
