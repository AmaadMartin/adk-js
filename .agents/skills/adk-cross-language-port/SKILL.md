---
name: adk-cross-language-port
description: >
  Port a feature from the ADK Python implementation (adk-python) into ADK for
  TypeScript, or check that an existing TypeScript module still matches its
  Python counterpart. Use when asked to port, copy, mirror, or reach parity
  with adk-python, or when reviewing a change described as "adk-python parity".
---

# Porting a feature from adk-python to adk-js

## 1. The source of truth is the Python module _and_ its tests

Read `src/google/adk/<area>/<name>.py` together with
`tests/unittests/<area>/test_<name>.py` in `adk-python` before writing any
TypeScript. The Python unit tests enumerate the edge cases the port must
reproduce; the module alone does not. If a behaviour is only visible in the
tests, it is still part of the spec.

## 2. Location mapping

| adk-python                              | adk-js                            |
| --------------------------------------- | --------------------------------- |
| `src/google/adk/<area>/<name>.py`       | `core/src/<area>/<name>.ts`       |
| `tests/unittests/<area>/test_<name>.py` | `core/test/<area>/<name>_test.ts` |
| `src/google/adk/cli/…`                  | `dev/src/cli/…`                   |
| `tests/integration/…`                   | `tests/integration/…`             |

Most area directories line up 1:1 and file names stay `snake_case` in both
repos. Not every area has a counterpart, though: Python's `cli/` is solved
differently by `dev/`, and `core/src` adds directories Python keeps elsewhere.
When an area does not map, say so in the PR rather than inventing a directory.

## 3. Idiom mapping

| Python                          | TypeScript                                               |
| ------------------------------- | -------------------------------------------------------- |
| `snake_case` methods and fields | `camelCase` (class names and file names are unchanged)   |
| Pydantic `BaseModel`            | an `interface`, plus a zod schema when parsed at runtime |
| keyword-only arguments          | a single options object parameter                        |
| `async def`                     | `async`                                                  |
| `AsyncGenerator`                | an `async *` generator, delegated with `yield*`          |
| `Optional[X]`                   | `X \| undefined` or an optional property — never `any`   |
| a custom exception class        | an `Error` subclass                                      |

`core/src/skills/skill.ts` is the in-repo example of an interface paired with a
zod schema. Prefer `yield*` over a callback parameter so callers can consume
the stream with a plain `for await`. Python-only dependencies have no automatic
TypeScript equivalent: find the idiomatic Node package or reimplement the
behaviour, and say which you did in the PR.

## 4. Export wiring

Browser-safe modules are exported from `core/src/common.ts`, which both
`core/src/index.ts` and `core/src/index_web.ts` re-export. Modules that need
Node-only APIs are exported from `core/src/index.ts` only. Export the _types_
referenced in a public signature as well as the values — `npm run docs:check`
treats an unexported referenced type as a warning and fails the build on it.

## 5. Port the tests, case by case

Translate the Python test cases one by one into
`core/test/<area>/<name>_test.ts` using vitest (`describe` / `it` / `expect`).
Import the symbol under test from `@google/adk`, not by relative path. A port
with fewer test cases than the Python original is incomplete — if a case does
not apply, delete it deliberately and note why in the PR.

## 6. Deliberate divergence

Where the TypeScript version cannot or should not mirror Python, document the
difference in TSDoc on the exported symbol and call it out in the PR
description. Do not port private or internal Python modules.

## 7. Verify before sending

```bash
npm run build
npx vitest run --project unit:core core/test/<area>/<name>_test.ts
npm run lint
npm run format
npm run docs:check
bash scripts/check_license.sh
```

Run the test target for the file you added, not the whole suite.

## 8. PR conventions

Mark the title as parity work using the established convention, as in
`Feat: Add ExampleTool for few-shot examples (adk-python parity)`, and name the
Python source path you ported in the PR body. Every new `.ts` file starts with
the standard header, whose exact shape `scripts/check_license.sh` enforces:

```ts
/**
 * @license
 * Copyright <year> Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
```
