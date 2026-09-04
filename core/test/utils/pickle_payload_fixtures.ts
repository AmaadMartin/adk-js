/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pickle payloads CPython produced, so the reader is tested against the real
 * encoder rather than against bytes this repository wrote itself.
 *
 * Every payload below is the base64 of `pickle.dumps(value, protocol)` run on
 * CPython 3.13.15 with pydantic 2.13.4, from this script:
 *
 * ```python
 * import base64, collections, pickle
 *
 * # example/models.py, on sys.path:
 * #   import pydantic
 * #   class Widget(pydantic.BaseModel):
 * #     label: str = ""
 * #     size: int = 0
 * from example.models import Widget
 *
 * def emit(name, obj, protocol=4):
 *   print(name, base64.b64encode(pickle.dumps(obj, protocol)))
 *
 * emit("PLAIN_DATA_PAYLOAD", {
 *     "text": "hello", "unicode": "caf\u00e9 \u2713", "byte_int": 200,
 *     "short_int": 4242, "int32": 123456789, "negative": -7,
 *     "big_int": 2 ** 80, "negative_big_int": -(2 ** 80), "float": 1.5,
 *     "true": True, "false": False, "none": None, "bytes": b"\x00\x01\xfe",
 *     "list": [1, 2, 3], "tuple": (1, "two", 3.0), "set": {1, 2},
 *     "frozenset": frozenset({"a"}), "nested": {"inner": [{"k": "v"}]},
 *     "empty_list": [], "empty_dict": {}, "empty_tuple": (),
 *     "long_text": "x" * 260, "long_bytes": b"y" * 260,
 * })
 * shared = {"shared": True}
 * emit("SHARED_REFERENCE_PAYLOAD", [shared, shared])
 * emit("TUPLES_PAYLOAD", {"one": (1,), "two": (1, 2), "three": (1, 2, 3)})
 * emit("SINGLE_APPEND_PAYLOAD", [42])
 * emit("REDUCE_VALUES_PAYLOAD", {
 *     "ordered": collections.OrderedDict([("b", 1), ("a", 2)]),
 *     "default": collections.defaultdict(list, {"k": [1]}),
 * })
 * emit("WIDGET_PAYLOAD", Widget(label="left", size=3))
 * emit("PROTOCOL_2_WIDGET_PAYLOAD", Widget(label="left", size=3), 2)
 * emit("PROTOCOL_5_DATA_PAYLOAD", {"proto": 5, "list": [1, 2]}, 5)
 * emit("SHARED_MODEL_PAYLOAD", [widget, widget])
 * ```
 */

/** Every primitive, container and length-prefix opcode, at protocol 4. */
export const PLAIN_DATA_PAYLOAD =
  'gASVmwMAAAAAAAB9lCiMBHRleHSUjAVoZWxsb5SMB3VuaWNvZGWUjAljYWbDqSDinJOU' +
  'jAhieXRlX2ludJRLyIwJc2hvcnRfaW50lE2SEIwFaW50MzKUShXNWweMCG5lZ2F0aXZl' +
  'lEr5////jAdiaWdfaW50lIoLAAAAAAAAAAAAAAGMEG5lZ2F0aXZlX2JpZ19pbnSUigsA' +
  'AAAAAAAAAAAA/4wFZmxvYXSURz/4AAAAAAAAjAR0cnVllIiMBWZhbHNllImMBG5vbmWU' +
  'TowFYnl0ZXOUQwMAAf6UjARsaXN0lF2UKEsBSwJLA2WMBXR1cGxllEsBjAN0d2+UR0AI' +
  'AAAAAAAAh5SMA3NldJSPlChLAUsCkIwJZnJvemVuc2V0lCiMAWGUkZSMBm5lc3RlZJR9' +
  'lIwFaW5uZXKUXZR9lIwBa5SMAXaUc2FzjAplbXB0eV9saXN0lF2UjAplbXB0eV9kaWN0' +
  'lH2UjAtlbXB0eV90dXBsZZQpjAlsb25nX3RleHSUWAQBAAB4eHh4eHh4eHh4eHh4eHh4' +
  'eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4' +
  'eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4' +
  'eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4' +
  'eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4' +
  'eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eJSMCmxvbmdfYnl0' +
  'ZXOUQgQBAAB5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5' +
  'eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5' +
  'eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5' +
  'eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5' +
  'eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5' +
  'eXl5eXl5eXl5eXl5eZR1Lg==';

/** Two references to one dictionary, so the reader has to read the memo. */
export const SHARED_REFERENCE_PAYLOAD =
  'gASVFAAAAAAAAABdlCh9lIwGc2hhcmVklIhzaAFlLg==';

/** `TUPLE1`, `TUPLE2` and `TUPLE3`. */
export const TUPLES_PAYLOAD =
  'gASVKwAAAAAAAAB9lCiMA29uZZRLAYWUjAN0d2+USwFLAoaUjAV0aHJlZZRLAUsCSwOH' +
  'lHUu';

/** A one-element list, which CPython writes with `APPEND` and no `MARK`. */
export const SINGLE_APPEND_PAYLOAD = 'gASVBgAAAAAAAABdlEsqYS4=';

/** `REDUCE` of `collections.OrderedDict` and of `collections.defaultdict`. */
export const REDUCE_VALUES_PAYLOAD =
  'gASViAAAAAAAAAB9lCiMB29yZGVyZWSUjAtjb2xsZWN0aW9uc5SMC09yZGVyZWREaWN0' +
  'lJOUKVKUKIwBYpRLAYwBYZRLAnWMB2RlZmF1bHSUjAtjb2xsZWN0aW9uc5SMC2RlZmF1' +
  'bHRkaWN0lJOUjAhidWlsdGluc5SMBGxpc3SUk5SFlFKUjAFrlF2USwFhc3Uu';

/** A pydantic v2 model: `STACK_GLOBAL`, `NEWOBJ` and `BUILD`. */
export const WIDGET_PAYLOAD =
  'gASVnAAAAAAAAACMDmV4YW1wbGUubW9kZWxzlIwGV2lkZ2V0lJOUKYGUfZQojAhfX2Rp' +
  'Y3RfX5R9lCiMBWxhYmVslIwEbGVmdJSMBHNpemWUSwN1jBJfX3B5ZGFudGljX2V4dHJh' +
  'X1+UTowXX19weWRhbnRpY19maWVsZHNfc2V0X1+Uj5QoaAdoCZCMFF9fcHlkYW50aWNf' +
  'cHJpdmF0ZV9flE51Yi4=';

/**
 * The same model at protocol 2, which names its classes with `GLOBAL` and
 * memoizes with `BINPUT`.
 *
 * Protocol 2 also spells the builtin module `__builtin__`, the Python 2 name.
 */
export const PROTOCOL_2_WIDGET_PAYLOAD =
  'gAJjZXhhbXBsZS5tb2RlbHMKV2lkZ2V0CnEAKYFxAX1xAihYCAAAAF9fZGljdF9fcQN9' +
  'cQQoWAUAAABsYWJlbHEFWAQAAABsZWZ0cQZYBAAAAHNpemVxB0sDdVgSAAAAX19weWRh' +
  'bnRpY19leHRyYV9fcQhOWBcAAABfX3B5ZGFudGljX2ZpZWxkc19zZXRfX3EJY19fYnVp' +
  'bHRpbl9fCnNldApxCl1xCyhoBWgHZYVxDFJxDVgUAAAAX19weWRhbnRpY19wcml2YXRl' +
  'X19xDk51Yi4=';

/** Protocol 5, whose `FRAME` opcode the reader has to skip. */
export const PROTOCOL_5_DATA_PAYLOAD =
  'gAWVHgAAAAAAAAB9lCiMBXByb3RvlEsFjARsaXN0lF2UKEsBSwJldS4=';

/**
 * One pydantic model referenced twice.
 *
 * CPython writes `MEMOIZE` before the model's `BUILD` and mutates the instance
 * in place, so the second reference is a `BINGET` of the memo slot.
 */
export const SHARED_MODEL_PAYLOAD =
  'gASVogAAAAAAAABdlCiMDmV4YW1wbGUubW9kZWxzlIwGV2lkZ2V0lJOUKYGUfZQojAhf' +
  'X2RpY3RfX5R9lCiMBWxhYmVslIwEbGVmdJSMBHNpemWUSwN1jBJfX3B5ZGFudGljX2V4' +
  'dHJhX1+UTowXX19weWRhbnRpY19maWVsZHNfc2V0X1+Uj5QoaAhoCpCMFF9fcHlkYW50' +
  'aWNfcHJpdmF0ZV9flE51YmgEZS4=';

/** Decodes a base64 fixture into the bytes a database column would hold. */
export function payloadBytes(base64Payload: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64Payload, 'base64'));
}
