/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pickle payloads generated from Python, recording the real adk-python module
 * paths so the reader's allowlist sees the names it would see in production.
 *
 * TypeScript cannot pickle a live object, so the reference tests' `pickle.dumps`
 * calls are replaced by these committed payloads.
 */

/** EventActions(state_delta={'skey': 4}) */
export const SIMPLE_STATE_DELTA =
  'gAWVKwEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwLc3RhdGVfZGVsdGGUfZSMBHNrZXmUSwRzjA5hcnRpZmFjdF9kZWx0YZR9lIwRdHJhbnNmZXJfdG9fYWdlbnSUTowIZXNjYWxhdGWUTowccmVxdWVzdGVkX3Rvb2xfY29uZmlybWF0aW9uc5R9lIwKY29tcGFjdGlvbpROjBFyZW5kZXJfdWlfd2lkZ2V0c5ROdYwSX19weWRhbnRpY19leHRyYV9flE6MF19fcHlkYW50aWNfZmllbGRzX3NldF9flI+UKGgHkIwUX19weWRhbnRpY19wcml2YXRlX1+UTnViLg==';

/** EventActions(state_delta={'skey': 4}, escalate=True) */
export const STATE_DELTA_AND_ESCALATE =
  'gAWVLQEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwLc3RhdGVfZGVsdGGUfZSMBHNrZXmUSwRzjA5hcnRpZmFjdF9kZWx0YZR9lIwRdHJhbnNmZXJfdG9fYWdlbnSUTowIZXNjYWxhdGWUiIwccmVxdWVzdGVkX3Rvb2xfY29uZmlybWF0aW9uc5R9lIwKY29tcGFjdGlvbpROjBFyZW5kZXJfdWlfd2lkZ2V0c5ROdYwSX19weWRhbnRpY19leHRyYV9flE6MF19fcHlkYW50aWNfZmllbGRzX3NldF9flI+UKGgHaA2QjBRfX3B5ZGFudGljX3ByaXZhdGVfX5ROdWIu';

/** EventActions(state_delta={'skey': 'updated'}, artifact_delta={'artifact.txt': 2}) */
export const SAFE_ACTIONS =
  'gAWVRwEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwLc3RhdGVfZGVsdGGUfZSMBHNrZXmUjAd1cGRhdGVklHOMDmFydGlmYWN0X2RlbHRhlH2UjAxhcnRpZmFjdC50eHSUSwJzjBF0cmFuc2Zlcl90b19hZ2VudJROjAhlc2NhbGF0ZZROjBxyZXF1ZXN0ZWRfdG9vbF9jb25maXJtYXRpb25zlH2UjApjb21wYWN0aW9ulE6MEXJlbmRlcl91aV93aWRnZXRzlE51jBJfX3B5ZGFudGljX2V4dHJhX1+UTowXX19weWRhbnRpY19maWVsZHNfc2V0X1+Uj5QoaAdoC5CMFF9fcHlkYW50aWNfcHJpdmF0ZV9flE51Yi4=';

/** EventActions holding a ToolConfirmation and an EventCompaction with Content */
export const NESTED_ACTIONS =
  'gAWVvwIAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwLc3RhdGVfZGVsdGGUfZSMDmFydGlmYWN0X2RlbHRhlH2UjBF0cmFuc2Zlcl90b19hZ2VudJROjAhlc2NhbGF0ZZROjBxyZXF1ZXN0ZWRfdG9vbF9jb25maXJtYXRpb25zlH2UjApmYy1jb25maXJtlIwiZ29vZ2xlLmFkay50b29scy50b29sX2NvbmZpcm1hdGlvbpSMEFRvb2xDb25maXJtYXRpb26Uk5QpgZR9lChoBX2UKIwEaGludJSMFEF1dGhvcml6ZSBleGVjdXRpb24/lIwJY29uZmlybWVklIl1jBJfX3B5ZGFudGljX2V4dHJhX1+UTowXX19weWRhbnRpY19maWVsZHNfc2V0X1+Uj5QoaBaQjBRfX3B5ZGFudGljX3ByaXZhdGVfX5ROdWJzjApjb21wYWN0aW9ulGgAjA9FdmVudENvbXBhY3Rpb26Uk5QpgZR9lChoBX2UKIwPc3RhcnRfdGltZXN0YW1wlEc/8AAAAAAAAIwNZW5kX3RpbWVzdGFtcJRHQAAAAAAAAACMEWNvbXBhY3RlZF9jb250ZW50lIwSZ29vZ2xlLmdlbmFpLnR5cGVzlIwHQ29udGVudJSTlCmBlH2UKGgFfZQojAVwYXJ0c5RdlGgmjARQYXJ0lJOUKYGUfZQoaAV9lIwEdGV4dJSMB3N1bW1hcnmUc2gZTmgaj5QoaDOQaBxOdWJhjARyb2xllIwFbW9kZWyUdWgZTmgaj5QoaCxoNpBoHE51YnVoGU5oGo+UKGgkaCNoJZBoHE51YowRcmVuZGVyX3VpX3dpZGdldHOUTnVoGU5oGo+UKGgNaB2QaBxOdWIu';

/** EventActions(state_delta={'last_seen': datetime(2026,1,1,12,30, tzinfo=utc)}) */
export const DATETIME_STATE_DELTA =
  'gAWVhAEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwLc3RhdGVfZGVsdGGUfZSMCWxhc3Rfc2VlbpSMCGRhdGV0aW1llIwIZGF0ZXRpbWWUk5RDCgfqAQEMHgAAAACUaAqMCHRpbWV6b25llJOUaAqMCXRpbWVkZWx0YZSTlEsASwBLAIeUUpSFlFKUhpRSlHOMDmFydGlmYWN0X2RlbHRhlH2UjBF0cmFuc2Zlcl90b19hZ2VudJROjAhlc2NhbGF0ZZROjBxyZXF1ZXN0ZWRfdG9vbF9jb25maXJtYXRpb25zlH2UjApjb21wYWN0aW9ulE6MEXJlbmRlcl91aV93aWRnZXRzlE51jBJfX3B5ZGFudGljX2V4dHJhX1+UTowXX19weWRhbnRpY19maWVsZHNfc2V0X1+Uj5QoaAeQjBRfX3B5ZGFudGljX3ByaXZhdGVfX5ROdWIu';

/** EventActions(state_delta={'last_seen': datetime(2026,1,1,12,30)}), no tzinfo */
export const NAIVE_DATETIME_STATE_DELTA =
  'gAWVVwEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwLc3RhdGVfZGVsdGGUfZSMCWxhc3Rfc2VlbpSMCGRhdGV0aW1llIwIZGF0ZXRpbWWUk5RDCgfqAQEMHgAAAACUhZRSlHOMDmFydGlmYWN0X2RlbHRhlH2UjBF0cmFuc2Zlcl90b19hZ2VudJROjAhlc2NhbGF0ZZROjBxyZXF1ZXN0ZWRfdG9vbF9jb25maXJtYXRpb25zlH2UjApjb21wYWN0aW9ulE6MEXJlbmRlcl91aV93aWRnZXRzlE51jBJfX3B5ZGFudGljX2V4dHJhX1+UTowXX19weWRhbnRpY19maWVsZHNfc2V0X1+Uj5QoaAeQjBRfX3B5ZGFudGljX3ByaXZhdGVfX5ROdWIu';

/** EventActions(render_ui_widgets=[UiWidget(id='widget-1', provider='mcp', payload={'resource_uri': 'ui://widget'})]) */
export const UI_WIDGET_ACTIONS =
  'gAWVuQEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwLc3RhdGVfZGVsdGGUfZSMDmFydGlmYWN0X2RlbHRhlH2UjBF0cmFuc2Zlcl90b19hZ2VudJROjAhlc2NhbGF0ZZROjBxyZXF1ZXN0ZWRfdG9vbF9jb25maXJtYXRpb25zlH2UjApjb21wYWN0aW9ulE6MEXJlbmRlcl91aV93aWRnZXRzlF2UjBtnb29nbGUuYWRrLmV2ZW50cy51aV93aWRnZXSUjAhVaVdpZGdldJSTlCmBlH2UKGgFfZQojAJpZJSMCHdpZGdldC0xlIwIcHJvdmlkZXKUjANtY3CUjAdwYXlsb2FklH2UjAxyZXNvdXJjZV91cmmUjAt1aTovL3dpZGdldJRzdYwSX19weWRhbnRpY19leHRyYV9flE6MF19fcHlkYW50aWNfZmllbGRzX3NldF9flI+UKGgaaBxoGJCMFF9fcHlkYW50aWNfcHJpdmF0ZV9flE51YmF1aCBOaCGPlChoEJBoI051Yi4=';

/** REDUCE(builtins.eval, ('...',)) - the shape adk-python's Evil.__reduce__ produces */
export const REFUSED_CALLABLE =
  'gAWVXwAAAAAAAACMCGJ1aWx0aW5zlIwEZXZhbJSTlIxDX19pbXBvcnRfXygnb3MnKS5lbnZpcm9uLnNldGRlZmF1bHQoJ0FES19NSUdSQVRJT05fUElDS0xFX1JDRScsJzEnKZSFlFKULg==';

/** SIMPLE_STATE_DELTA written with protocol 2: GLOBAL, BINPUT, BINUNICODE */
export const PROTOCOL_2_ACTIONS =
  'gAJjZ29vZ2xlLmFkay5ldmVudHMuZXZlbnRfYWN0aW9ucwpFdmVudEFjdGlvbnMKcQApgXEBfXECKFgIAAAAX19kaWN0X19xA31xBChYCwAAAHN0YXRlX2RlbHRhcQV9cQZYBAAAAHNrZXlxB0sEc1gOAAAAYXJ0aWZhY3RfZGVsdGFxCH1xCVgRAAAAdHJhbnNmZXJfdG9fYWdlbnRxCk5YCAAAAGVzY2FsYXRlcQtOWBwAAAByZXF1ZXN0ZWRfdG9vbF9jb25maXJtYXRpb25zcQx9cQ1YCgAAAGNvbXBhY3Rpb25xDk5YEQAAAHJlbmRlcl91aV93aWRnZXRzcQ9OdVgSAAAAX19weWRhbnRpY19leHRyYV9fcRBOWBcAAABfX3B5ZGFudGljX2ZpZWxkc19zZXRfX3ERY19fYnVpbHRpbl9fCnNldApxEl1xE2gFYYVxFFJxFVgUAAAAX19weWRhbnRpY19wcml2YXRlX19xFk51Yi4=';

/** [0, 255, 256, 65535, 65536, 2147483647, -1, 2**70, -(2**70)] */
export const INT_WIDTHS =
  'gAWVNAAAAAAAAABdlChLAEv/TQABTf//SgAAAQBK////f0r/////igkAAAAAAAAAAECKCQAAAAAAAAAAwGUu';

/** [1.5, -0.25, True, False, None] */
export const FLOAT_AND_BOOL =
  'gAWVGgAAAAAAAABdlChHP/gAAAAAAABHv9AAAAAAAACIiU5lLg==';

/** ['ascii', 'unicode é✓', b'\x00\x01\xff', 'x'*300, b'y'*300] */
export const TEXT_AND_BYTES =
  'gAWVhwIAAAAAAABdlCiMBWFzY2lplIwNdW5pY29kZSDDqeKck5RDAwAB/5RYLAEAAHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eJRCLAEAAHl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eZRlLg==';

/** [[], (), {}, set(), frozenset(), [1,2,3], (1,2,3,4), {'a': 1}, {1,2}] */
export const CONTAINERS =
  'gAWVNQAAAAAAAABdlChdlCl9lI+UKJGUXZQoSwFLAksDZShLAUsCSwNLBHSUfZSMAWGUSwFzj5QoSwFLApBlLg==';

/** {1: 'one', (2, 3): 'tuple'} */
export const NON_STRING_DICT_KEYS =
  'gAWVGwAAAAAAAAB9lChLAYwDb25llEsCSwOGlIwFdHVwbGWUdS4=';

/** [Decimal('1.5'), PurePosixPath('a/b'), UUID(...), date(2026,1,2), time(12,30,1,500000), OrderedDict, defaultdict] */
export const STDLIB_VALUES =
  'gAWVHgEAAAAAAABdlCiMB2RlY2ltYWyUjAdEZWNpbWFslJOUjAMxLjWUhZRSlIwOcGF0aGxpYi5fbG9jYWyUjA1QdXJlUG9zaXhQYXRolJOUjANhL2KUhZRSlIwEdXVpZJSMBFVVSUSUk5QpgZR9lIwDaW50lIoQeFY0EnhWNBJ4VjQSeFY0EnNijAhkYXRldGltZZSMBGRhdGWUk5RDBAfqAQKUhZRSlGgTjAR0aW1llJOUQwYMHgEHoSCUhZRSlIwLY29sbGVjdGlvbnOUjAtPcmRlcmVkRGljdJSTlClSlIwBYZRLAXOMC2NvbGxlY3Rpb25zlIwLZGVmYXVsdGRpY3SUk5SMCGJ1aWx0aW5zlIwEbGlzdJSTlIWUUpRoIl2USwFhc2Uu';

/** REDUCE(builtins.str, ('hello',)) */
export const BUILTIN_REDUCE_STR =
  'gAWVIAAAAAAAAACMCGJ1aWx0aW5zlIwDc3RylJOUjAVoZWxsb5SFlFKULg==';

/** REDUCE(builtins.dict, ()) */
export const BUILTIN_REDUCE_DICT =
  'gAWVGAAAAAAAAACMCGJ1aWx0aW5zlIwEZGljdJSTlClSlC4=';

/** REDUCE(builtins.list, ()) */
export const BUILTIN_REDUCE_LIST =
  'gAWVGAAAAAAAAACMCGJ1aWx0aW5zlIwEbGlzdJSTlClSlC4=';

/** REDUCE(builtins.set, ([1, 2],)) */
export const BUILTIN_REDUCE_SET =
  'gAWVIAAAAAAAAACMCGJ1aWx0aW5zlIwDc2V0lJOUXZQoSwFLAmWFlFKULg==';

/** REDUCE(builtins.object, ()) */
export const BUILTIN_REDUCE_OBJECT =
  'gAWVGgAAAAAAAACMCGJ1aWx0aW5zlIwGb2JqZWN0lJOUKVKULg==';

/** REDUCE(copyreg._reconstructor, (UiWidget, object, None)) */
export const COPYREG_RECONSTRUCTOR =
  'gAWVZAAAAAAAAACMB2NvcHlyZWeUjA5fcmVjb25zdHJ1Y3RvcpSTlIwbZ29vZ2xlLmFkay5ldmVudHMudWlfd2lkZ2V0lIwIVWlXaWRnZXSUk5SMCGJ1aWx0aW5zlIwGb2JqZWN0lJOUToeUUpQu';

/** REDUCE(os.system, ('echo',)) - a global outside the allowlist */
export const REFUSED_MODULE =
  'gAWVHwAAAAAAAACMBXBvc2l4lIwGc3lzdGVtlJOUjARlY2hvlIWUUpQu';

/** REDUCE(google.genai.types.PartMediaResolution, ('MEDIA_RESOLUTION_LOW',)) */
export const ENUM_MEMBER =
  'gAWVSQAAAAAAAACMEmdvb2dsZS5nZW5haS50eXBlc5SME1BhcnRNZWRpYVJlc29sdXRpb26Uk5SMFE1FRElBX1JFU09MVVRJT05fTE9XlIWUUpQu';

/** google.adk.events.event_actions.NewObjEx via NEWOBJ_EX */
export const NEWOBJ_EX_OBJECT =
  'gAWVUAAAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAhOZXdPYmpFeJSTlIwKcG9zaXRpb25hbJSFlH2UjAdrZXl3b3JklEsBc5KULg==';

/** [timedelta(1, 2, 3000), timezone(timedelta(hours=5, minutes=30))] */
export const TIMEDELTA_AND_TIMEZONE =
  'gAWVSQAAAAAAAABdlCiMCGRhdGV0aW1llIwJdGltZWRlbHRhlJOUSwFLAk24C4eUUpRoAYwIdGltZXpvbmWUk5RoA0sATVhNSwCHlFKUhZRSlGUu';

/** REDUCE(datetime.timedelta, ('bad',)) */
export const TIMEDELTA_NON_NUMERIC =
  'gAWVJAAAAAAAAACMCGRhdGV0aW1llIwJdGltZWRlbHRhlJOUjANiYWSUhZRSlC4=';

/** REDUCE(datetime.timezone, ('bad',)) */
export const TIMEZONE_NON_NUMERIC =
  'gAWVIwAAAAAAAACMCGRhdGV0aW1llIwIdGltZXpvbmWUk5SMA2JhZJSFlFKULg==';

/** REDUCE(copyreg._reconstructor, ('not-a-class',)) */
export const RECONSTRUCTOR_WITHOUT_CLASS =
  'gAWVMAAAAAAAAACMB2NvcHlyZWeUjA5fcmVjb25zdHJ1Y3RvcpSTlIwLbm90LWEtY2xhc3OUhZRSlC4=';

/** REDUCE(builtins.set, ()) */
export const BUILTIN_REDUCE_SET_NO_ARGS =
  'gAWVFwAAAAAAAACMCGJ1aWx0aW5zlIwDc2V0lJOUKVKULg==';

/** REDUCE(builtins.str, ()) */
export const BUILTIN_REDUCE_STR_NO_ARGS =
  'gAWVFwAAAAAAAACMCGJ1aWx0aW5zlIwDc3RylJOUKVKULg==';

/** A UiWidget whose BUILD state is a tuple, not a dict */
export const BUILD_FROM_NON_DICT_STATE =
  'gAWVPwAAAAAAAACMG2dvb2dsZS5hZGsuZXZlbnRzLnVpX3dpZGdldJSMCFVpV2lkZ2V0lJOUKVKUjApub3QtYS1kaWN0lIWUYi4=';

/** 2 ** 2100, wide enough to need LONG4 */
export const HUGE_INT =
  'gAWVDQEAAAAAAACLBwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQLg==';

/** Decodes a committed base64 fixture into the bytes a driver would return. */
export function fixtureBytes(base64Payload: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64Payload, 'base64'));
}
