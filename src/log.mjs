/**
 * Tiny levelled logger with secret redaction.
 *
 * NeoSolver holds a provider API key and a client token. Neither may ever be
 * written to a log, an HTTP response, or the startup banner. Every log line and
 * every outgoing error message is passed through {@link Logger#redact} first,
 * so even an accidental interpolation cannot leak a secret.
 *
 * Logging must never be able to break the service: every file operation here is
 * best-effort and swallows its own errors.
 */

import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, silent: 99 };

export class Logger {
  /**
   * @param {{level?: string, secrets?: Array<string|null|undefined>,
   *          stream?: NodeJS.WritableStream, filePath?: string,
   *          fileMaxBytes?: number}} [options]
   *   `filePath` enables a file sink; `fileMaxBytes` bounds it (0 disables
   *   rotation). When a file sink is on, stderr is only echoed when it is a TTY,
   *   so an unattended service does not write every line twice.
   */
  constructor({
    level = 'info',
    secrets = [],
    stream = process.stderr,
    filePath = '',
    fileMaxBytes = 5 * 1024 * 1024,
  } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.stream = stream;
    this.filePath = typeof filePath === 'string' ? filePath : '';
    this.fileMaxBytes = Number.isFinite(fileMaxBytes) ? fileMaxBytes : 0;
    this.fd = null;
    // Longest first so overlapping secrets cannot partially mask each other.
    this.secrets = secrets
      .filter((value) => typeof value === 'string' && value.length >= 3)
      .sort((a, b) => b.length - a.length);
    if (this.filePath !== '') this.#openFile();
  }

  /** Open (creating the parent directory) the append-only log file. */
  #openFile() {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.fd = openSync(this.filePath, 'a');
    } catch (error) {
      this.fd = null;
      try {
        this.stream.write(`neosolver: cannot open log file ${this.filePath}: ${error.message}\n`);
      } catch {
        /* nowhere left to report to */
      }
    }
  }

  /**
   * Rotate to `<file>.1` (one generation, no unbounded chain) when writing the
   * next line would exceed the cap, so an unattended service cannot fill the
   * disk. A failed rotation degrades to "keep appending" rather than throwing.
   */
  #rotateIfNeeded(bytes) {
    if (this.fd === null || this.fileMaxBytes <= 0) return;

    let size;
    try {
      size = fstatSync(this.fd).size;
    } catch {
      return;
    }
    if (size + bytes <= this.fileMaxBytes) return;

    try {
      closeSync(this.fd);
      this.fd = null;
      renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      /* best effort — fall through and keep appending */
    }
    this.#openFile();
  }

  /** Write one formatted line to every enabled sink. */
  #writeLine(line) {
    const text = `${line}\n`;
    this.#rotateIfNeeded(Buffer.byteLength(text));

    if (this.fd !== null) {
      try {
        writeSync(this.fd, text);
      } catch {
        /* logging must never throw */
      }
    }

    // Echo to stderr unless a file sink already owns the log AND stderr is not a
    // terminal. With no file sink, stderr is the log and must always be written —
    // a spawned service has a piped (non-TTY) stderr and silencing it would make
    // the process look dead.
    const echo = this.fd === null || this.stream !== process.stderr || process.stderr.isTTY === true;
    if (echo) {
      try {
        this.stream.write(text);
      } catch {
        /* ignore */
      }
    }
  }

  /** Replace every known secret with `[REDACTED]`. */
  redact(text) {
    let out = String(text);
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    }
    return out;
  }

  #emit(level, message, fields) {
    if (LEVELS[level] > this.level) return;
    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    if (fields && Object.keys(fields).length > 0) {
      for (const [key, value] of Object.entries(fields)) {
        line += ` ${key}=${formatValue(value)}`;
      }
    }
    this.#writeLine(this.redact(line));
  }

  error(message, fields) {
    this.#emit('error', message, fields);
  }
  warn(message, fields) {
    this.#emit('warn', message, fields);
  }
  info(message, fields) {
    this.#emit('info', message, fields);
  }
  debug(message, fields) {
    this.#emit('debug', message, fields);
  }

  /** Release the file descriptor. Safe to call more than once. */
  close() {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      /* ignore */
    }
    this.fd = null;
  }
}

function formatValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

/** Convenience factory. */
export function createLogger(options = {}) {
  return new Logger(options);
}

/** Bound an arbitrary string for safe inclusion in an error message. */
export function excerpt(text, max = 400) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}… [${flat.length - max} more characters truncated]`;
}
