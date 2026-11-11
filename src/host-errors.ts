/**
 * JSON-RPC error codes emitted by the host: the standard -327xx range plus the AHP-specific -320xx codes.
 */

export const ERROR_PARSE = -32700;

export const ERROR_INVALID_REQUEST = -32600;

export const ERROR_METHOD_NOT_FOUND = -32601;

export const ERROR_INTERNAL = -32603;

export const ERROR_SESSION_NOT_FOUND = -32001;

export const ERROR_NO_PROVIDER = -32002;

export const ERROR_SESSION_EXISTS = -32003;

export const ERROR_NOT_FOUND = -32008;

export const ERROR_PERMISSION_DENIED = -32009;

/**
 * AHP `AlreadyExists` (-32010): the target resource already exists. This
 * host's use: a `createTerminal` for a channel that is already open.
 * (AHP 1.0.0 defines no "not supported" code — the -32600…-32603
 * standard range covers those shapes.)
 */
export const ERROR_ALREADY_EXISTS = -32010;
