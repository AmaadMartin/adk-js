# Adding a session database schema version

`DatabaseSessionService` stores its schema version in the `adk_internal_metadata`
table, under the key `schema_version`. `schema_version.ts` owns the negotiation:

- `LATEST_SCHEMA_VERSION` — the version stamped on a database this build creates.
- `SUPPORTED_SCHEMA_VERSIONS` — the versions this build can read and write.
- `upgradeSessionDatabaseSchema()` — the operator entry point that brings an
  older database up to the latest version in place.

The table name and the key string are a cross-language contract. adk-python reads
and writes the same row, so neither may change.

## Backward compatibility policy

adk-python states the policy this package follows: "The `DatabaseSessionService`
is designed to be backward-compatible with the previous schema for a few releases
(at least 2)." A version therefore stays in `SUPPORTED_SCHEMA_VERSIONS` for at
least two releases after it stops being the latest.

## Steps to add version N+1

Assume the current version is `1` and you are adding `2`.

1. **Keep the change additive.** Add a nullable column, a new table, or a new
   index. `ensureDatabaseCreated()` runs `updateSchema({safe: true})`, which
   applies exactly those and never drops anything. An additive change is readable
   by both the old and the new client. A non-additive change is a much larger job
   — see "If the change cannot be additive" below.
2. **Edit the entities** in `schema.ts`.
3. **Add the constant** in `schema_version.ts`:
   `export const SCHEMA_VERSION_2 = '2';`
4. **Point `LATEST_SCHEMA_VERSION` at it** and add it to
   `SUPPORTED_SCHEMA_VERSIONS`. Keep `'1'` in the set for its deprecation window.
5. **Branch the business logic** in `DatabaseSessionService` on the stored
   version if a `'1'` database needs different reads or writes. Use
   `readSchemaVersion()`; do not add a second entity set.
6. **Warn on the older version.** `validateDatabaseSchemaVersion()` accepts an
   older supported version silently, because there is no supported-but-older
   version yet. Add
   `if (version !== LATEST_SCHEMA_VERSION) logger.warn(...)` after the
   `assertCompatibleVersion()` call, pointing operators at
   `upgradeSessionDatabaseSchema()`.
7. **Test the pair.** Cover a `'1'` database opened by the new build, and the
   upgrade from `'1'` to `'2'`.
8. **Deprecate.** After at least two releases, remove `'1'` from
   `SUPPORTED_SCHEMA_VERSIONS`. A `'1'` database then fails to open with the
   error that names `upgradeSessionDatabaseSchema()`.

## Why there is only one entity set

adk-python keeps a complete SQLAlchemy model set per version (`schemas/v0.py`,
`schemas/v1.py`) and selects one at runtime with its `_SchemaClasses` helper.
Two declarative metadatas can coexist in one process and either can be bound to
an engine at call time.

MikroORM cannot do that. `MikroORM.init()` discovers and freezes entity metadata,
and `DatabaseSessionService` passes `entities: ENTITIES` in before init. Selecting
an entity set per database would need, in order:

1. a throwaway pre-init connection purely to read `adk_internal_metadata`;
2. closing it and re-initialising the real ORM with the selected set;
3. an indirection object over every `em.find` / `em.create` call in
   `DatabaseSessionService`, mirroring `_SchemaClasses`;
4. duplicate entity classes with duplicate `tableName` declarations, which
   MikroORM's discovery rejects unless the lists are disjoint.

That cost is paid on every startup, so this package keeps one entity set and
makes each bump additive instead.

## If the change cannot be additive

A retyped column, a removed column, or a changed payload encoding cannot be read
by both clients. That is the only case that forces the `_SchemaClasses`
equivalent, at the four costs above. Consider a new table that the old client
ignores before you take that on.
