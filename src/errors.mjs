/**
 * Typed errors for NeoSolver.
 *
 * Every error that can reach a client carries an HTTP `status` and a stable
 * machine-readable `code`. Messages are written to be actionable and are
 * guaranteed (by construction and by the server) never to contain secrets.
 */

export class NeoError extends Error {
  /**
   * @param {string} code   stable machine-readable code, e.g. `bad_request`
   * @param {number} status HTTP status to answer with
   * @param {string} message human-readable, actionable, secret-free
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, status, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NeoError';
    this.code = code;
    this.status = status;
  }

  /** Wire shape: `{"error":{"code":"...","message":"..."}}` */
  toWire() {
    return { error: { code: this.code, message: this.message } };
  }
}

export const isNeoError = (value) => value instanceof NeoError;

export const badRequest = (message) => new NeoError('bad_request', 400, message);
export const unauthorized = (message = 'invalid or missing token') =>
  new NeoError('unauthorized', 401, message);
export const notFound = (message = 'no such endpoint') =>
  new NeoError('not_found', 404, message);
export const methodNotAllowed = (message) =>
  new NeoError('method_not_allowed', 405, message);
export const payloadTooLarge = (message) =>
  new NeoError('payload_too_large', 413, message);
export const rateLimited = (message) => new NeoError('rate_limited', 429, message);
export const serviceUnavailable = (message) => new NeoError('service_unavailable', 503, message);
export const unsafePath = (message) => new NeoError('unsafe_path', 502, message);
export const emptySolution = (message) =>
  new NeoError('empty_solution', 502, message);
export const unprocessableReply = (message) =>
  new NeoError('unprocessable_reply', 502, message);
export const providerError = (message, cause) =>
  new NeoError('provider_error', 502, message, { cause });
export const providerTimeout = (message, cause) =>
  new NeoError('provider_timeout', 504, message, { cause });
