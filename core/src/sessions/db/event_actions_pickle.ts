/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  transformToCamelCaseActions,
  transformToSnakeCaseActions,
} from '../../events/event.js';
import {createEventActions, EventActions} from '../../events/event_actions.js';
import {
  dumpPickle,
  loadPickle,
  PickleError,
  PickleErrorCode,
  PickleGlobal,
  PickleInstance,
  PickleObjectFactory,
  PickleSecurityError,
} from '../../utils/pickle_utils.js';
import {
  pickleToPlain,
  plainToPickle,
  PYTHON_STDLIB_PICKLE_FACTORIES,
} from '../../utils/python_pickle_utils.js';

/**
 * The codec for the `actions` column of the legacy v0 session schema.
 *
 * That column holds a Python pickle of adk-python's `EventActions`. Bytes read
 * back from a database are untrusted input, so they are decoded through an
 * allowlist that only admits the types `EventActions` can hold. This mirrors
 * `src/google/adk/sessions/_restricted_pickle.py` in adk-python.
 */

/** The class a legacy `events.actions` payload names. */
export const EVENT_ACTIONS_PICKLE_CLASS: PickleGlobal = {
  module: 'google.adk.events.event_actions',
  name: 'EventActions',
};

/**
 * The adk-python and FastAPI model classes an `EventActions` can hold.
 *
 * adk-python derives this set by walking the pydantic field annotations of
 * `EventActions` and `AuthConfig`. TypeScript has no runtime annotation tree,
 * so the set is declared here instead: a model added to `EventActions` in
 * Python needs a line added below.
 *
 * A class listed here is inert data. Resolving one builds a plain object from
 * the payload's own bytes; it never runs Python code, because there is no
 * Python here to run.
 */
const ALLOWED_MODEL_GLOBALS: ReadonlySet<string> = new Set([
  'google.adk.events.event_actions.EventActions',
  'google.adk.events.event_actions.EventCompaction',
  'google.adk.events.ui_widget.UiWidget',
  'google.adk.auth.auth_tool.AuthConfig',
  'google.adk.auth.auth_credential.AuthCredential',
  'google.adk.auth.auth_credential.AuthCredentialTypes',
  'google.adk.auth.auth_credential.HttpAuth',
  'google.adk.auth.auth_credential.HttpCredentials',
  'google.adk.auth.auth_credential.OAuth2Auth',
  'google.adk.auth.auth_credential.ServiceAccount',
  'google.adk.auth.auth_credential.ServiceAccountCredential',
  'google.adk.auth.auth_schemes.AuthSchemeType',
  'google.adk.auth.auth_schemes.CustomAuthScheme',
  'google.adk.auth.auth_schemes.ExtendedOAuth2',
  'google.adk.auth.auth_schemes.OAuthGrantType',
  'google.adk.auth.auth_schemes.OpenIdConnectWithConfig',
  'google.adk.tools.tool_confirmation.ToolConfirmation',
  'fastapi.openapi.models.APIKey',
  'fastapi.openapi.models.APIKeyIn',
  'fastapi.openapi.models.HTTPBase',
  'fastapi.openapi.models.HTTPBearer',
  'fastapi.openapi.models.OAuth2',
  'fastapi.openapi.models.OAuthFlow',
  'fastapi.openapi.models.OAuthFlows',
  'fastapi.openapi.models.OpenIdConnect',
  'fastapi.openapi.models.SecurityBase',
  'fastapi.openapi.models.SecurityScheme',
]);

/**
 * Modules whose every member is admitted as a model.
 *
 * `google.genai.types` is a generated module of pydantic models and enums,
 * reachable from an `EventActions` through its compacted content. Naming its
 * several hundred classes one by one would go stale on the next release of the
 * SDK, so the module is admitted as a whole. This is the one place the
 * allowlist is coarser than adk-python's derived set.
 */
const ALLOWED_MODEL_MODULES: ReadonlySet<string> = new Set([
  'google.genai.types',
]);

/**
 * Builds a pydantic model or an enum member from a payload.
 *
 * A pydantic v2 model is written as `__new__` with no arguments followed by a
 * `BUILD` of its `__getstate__` dictionary, whose `__dict__` entry holds the
 * fields. An enum member is written as a call of its class on the member's
 * value, so a single argument is the value itself.
 *
 * The fields are copied into the instance the reader already memoized, rather
 * than returned as a new value. A payload that names one model under two keys
 * writes it once and references the memo the second time, so replacing the
 * instance would hand the second reference an empty object.
 */
const PYDANTIC_VALUE_FACTORY: PickleObjectFactory = {
  create: (args) => (args.length === 1 ? args[0] : new Map<unknown, unknown>()),
  setState: (instance, state) => {
    if (!(state instanceof Map)) {
      throw new PickleError(
        PickleErrorCode.UNSUPPORTED_TARGET,
        'A pickled model in a legacy `events.actions` value needs a ' +
          'dictionary state.',
      );
    }
    const fields = state.get('__dict__') ?? state;
    if (!(instance instanceof Map) || !(fields instanceof Map)) {
      throw new PickleError(
        PickleErrorCode.UNSUPPORTED_TARGET,
        'A pickled model in a legacy `events.actions` value needs its fields ' +
          'in a dictionary.',
      );
    }
    for (const [name, value] of fields) {
      instance.set(name, value);
    }
    return instance;
  },
};

/**
 * Resolves a global a legacy `events.actions` payload names.
 *
 * @throws PickleSecurityError when the global is outside the allowlist.
 */
function resolveEventActionsGlobal(
  pickleGlobal: PickleGlobal,
): PickleObjectFactory {
  const key = `${pickleGlobal.module}.${pickleGlobal.name}`;
  const stdlibFactory = PYTHON_STDLIB_PICKLE_FACTORIES.get(key);
  if (stdlibFactory) {
    return stdlibFactory;
  }
  if (
    ALLOWED_MODEL_GLOBALS.has(key) ||
    ALLOWED_MODEL_MODULES.has(pickleGlobal.module)
  ) {
    return PYDANTIC_VALUE_FACTORY;
  }
  throw new PickleSecurityError(
    `Refusing to load ${key} from a legacy pickled \`events.actions\` value:` +
      ' it is not a type that `EventActions` can hold. This value was either' +
      ' not written by ADK, or it holds session state that is not plain data' +
      ' (for example a callable).',
  );
}

/**
 * The fields `createEventActions` gives an empty object.
 *
 * A blob carrying `None` for one of them would otherwise leave it null, and
 * the next caller reading its keys would fail. adk-python's annotations are
 * not optional, so only a corrupt blob reaches that, and the default is a
 * safer reading of it than a crash further away.
 */
const DICTIONARY_COLUMNS = [
  'state_delta',
  'artifact_delta',
  'requested_auth_configs',
  'requested_tool_confirmations',
] as const;

/**
 * Decodes the `actions` column of a legacy v0 event row.
 *
 * A field adk-python declares and adk-js does not is decoded and carried on
 * the returned object, so a mixed deployment does not lose it on the way
 * through a Node process.
 *
 * @param blob The stored pickle, which is untrusted input.
 * @returns The actions the blob holds.
 * @throws PickleSecurityError when the blob names a type outside the
 *   allowlist, and {@link PickleError} when it is malformed. A failure is not
 *   swallowed into empty actions: silently losing a `stateDelta` is the defect
 *   this codec exists to fix.
 */
export function decodeEventActionsPickle(blob: Uint8Array): EventActions {
  const fields = pickleToPlain(loadPickle(blob, resolveEventActionsGlobal));
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new PickleError(
      PickleErrorCode.UNSUPPORTED_TARGET,
      'A legacy `events.actions` value must hold an EventActions object.',
    );
  }
  const record = fields as Record<string, unknown>;
  for (const column of DICTIONARY_COLUMNS) {
    if (record[column] === null) {
      delete record[column];
    }
  }
  return createEventActions(transformToCamelCaseActions(record));
}

/**
 * Encodes actions into the `actions` column of a legacy v0 event row.
 *
 * The payload is the shape CPython produces for a pydantic v2 model: the class
 * global, `__new__` with no arguments, then a `BUILD` of the model's
 * `__getstate__` dictionary. That dictionary's four keys are pydantic v2
 * internals, so this is the one part of the legacy codec that depends on a
 * pydantic implementation detail rather than on the pickle format.
 *
 * @param actions The actions to store.
 * @returns The bytes to write to the column.
 */
export function encodeEventActionsPickle(actions: EventActions): Uint8Array {
  const fields = new Map<unknown, unknown>();
  for (const [name, value] of Object.entries(
    transformToSnakeCaseActions(actions),
  )) {
    if (value !== undefined) {
      fields.set(name, plainToPickle(value));
    }
  }
  const instance: PickleInstance = {
    kind: 'pickle-instance',
    global: EVENT_ACTIONS_PICKLE_CLASS,
    args: [],
    state: new Map<unknown, unknown>([
      ['__dict__', fields],
      ['__pydantic_extra__', null],
      ['__pydantic_fields_set__', new Set(fields.keys())],
      ['__pydantic_private__', null],
    ]),
  };
  return dumpPickle(instance);
}
