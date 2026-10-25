"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventStreamParser = void 0;
const CLOSE_TAG = Buffer.from('</EventNotificationAlert>');
const OPEN_TAG = Buffer.from('<EventNotificationAlert');
const MAX_HEADER_BYTES = 16 * 1024;
/**
 * Incremental parser for the ISAPI alertStream (multipart/mixed with XML,
 * JSON or image parts) with a fallback for streams of bare XML documents.
 * Handles arbitrary chunk boundaries and several parts per chunk. Memory is
 * bounded by `maxBufferBytes`.
 */
class EventStreamParser {
    opts;
    buf = Buffer.alloc(0);
    state = 'seek';
    headers = {};
    contentLength;
    skipRemaining = 0;
    delim;
    maxBuffer;
    maxPart;
    constructor(opts) {
        this.opts = opts;
        this.delim = opts.boundary ? Buffer.from(`--${opts.boundary}`) : undefined;
        this.maxPart = opts.maxPartBytes ?? 2 * 1024 * 1024;
        this.maxBuffer = Math.max(opts.maxBufferBytes ?? 4 * 1024 * 1024, this.maxPart + 64 * 1024);
    }
    feed(chunk) {
        let data = chunk;
        if (this.state === 'skip') {
            const n = Math.min(this.skipRemaining, data.length);
            this.skipRemaining -= n;
            data = data.subarray(n);
            if (this.skipRemaining === 0) {
                this.state = 'seek';
            }
            if (!data.length) {
                return;
            }
        }
        this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
        if (this.delim) {
            this.processBoundary(this.delim);
        }
        else {
            this.processRaw();
        }
        if (this.buf.length > this.maxBuffer) {
            this.opts.onError(`Stream buffer limit of ${this.maxBuffer} bytes exceeded; resynchronizing`);
            this.buf = Buffer.alloc(0);
            this.state = 'seek';
        }
    }
    emit(contentType, headers, body) {
        try {
            this.opts.onPart({ contentType, headers, body });
        }
        catch (err) {
            this.opts.onError(`Part handler failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    processBoundary(delim) {
        for (;;) {
            if (this.state === 'seek') {
                const idx = this.buf.indexOf(delim);
                if (idx < 0) {
                    const keep = delim.length - 1;
                    if (this.buf.length > keep) {
                        this.buf = this.buf.subarray(this.buf.length - keep);
                    }
                    return;
                }
                const p = idx + delim.length;
                const nl = this.buf.indexOf(0x0a, p);
                if (nl < 0) {
                    this.buf = this.buf.subarray(idx);
                    return;
                }
                const rest = this.buf.subarray(p, nl).toString('latin1').trim();
                this.buf = this.buf.subarray(nl + 1);
                if (rest.startsWith('--')) {
                    continue; // closing delimiter, keep seeking
                }
                this.headers = {};
                this.contentLength = undefined;
                this.state = 'headers';
                continue;
            }
            if (this.state === 'headers') {
                let end;
                let sepLen;
                if (this.buf[0] === 0x0d && this.buf[1] === 0x0a) {
                    end = 0;
                    sepLen = 2;
                }
                else if (this.buf[0] === 0x0a) {
                    end = 0;
                    sepLen = 1;
                }
                else {
                    const crlf = this.buf.indexOf('\r\n\r\n');
                    const lf = this.buf.indexOf('\n\n');
                    if (crlf >= 0 && (lf < 0 || crlf < lf)) {
                        end = crlf;
                        sepLen = 4;
                    }
                    else if (lf >= 0) {
                        end = lf;
                        sepLen = 2;
                    }
                    else {
                        if (this.buf.length > MAX_HEADER_BYTES) {
                            this.opts.onError('Part header too large; resynchronizing');
                            this.buf = Buffer.alloc(0);
                            this.state = 'seek';
                        }
                        return;
                    }
                }
                const headerText = this.buf.subarray(0, end).toString('latin1');
                this.buf = this.buf.subarray(end + sepLen);
                for (const line of headerText.split(/\r?\n/)) {
                    const colon = line.indexOf(':');
                    if (colon > 0) {
                        this.headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
                    }
                }
                const len = parseInt(this.headers['content-length'] ?? '', 10);
                this.contentLength = Number.isFinite(len) && len >= 0 ? len : undefined;
                if (this.contentLength !== undefined && this.contentLength > this.maxPart) {
                    this.opts.onError(`Part of ${this.contentLength} bytes exceeds limit of ${this.maxPart}; skipped`);
                    const n = Math.min(this.contentLength, this.buf.length);
                    this.buf = this.buf.subarray(n);
                    this.skipRemaining = this.contentLength - n;
                    this.state = this.skipRemaining > 0 ? 'skip' : 'seek';
                    if (this.state === 'skip') {
                        return;
                    }
                    continue;
                }
                this.state = 'body';
                continue;
            }
            if (this.state === 'body') {
                const contentType = this.headers['content-type'] ?? '';
                if (this.contentLength !== undefined) {
                    if (this.buf.length < this.contentLength) {
                        return;
                    }
                    const body = this.buf.subarray(0, this.contentLength);
                    this.buf = this.buf.subarray(this.contentLength);
                    this.state = 'seek';
                    this.emit(contentType, this.headers, body);
                    continue;
                }
                const idx = this.buf.indexOf(delim);
                if (idx < 0) {
                    if (this.buf.length > this.maxPart) {
                        this.opts.onError(`Part without Content-Length exceeds ${this.maxPart} bytes; dropped`);
                        this.buf = Buffer.alloc(0);
                        this.state = 'seek';
                    }
                    return;
                }
                let end = idx;
                if (end >= 2 && this.buf[end - 2] === 0x0d && this.buf[end - 1] === 0x0a) {
                    end -= 2;
                }
                else if (end >= 1 && this.buf[end - 1] === 0x0a) {
                    end -= 1;
                }
                const body = this.buf.subarray(0, end);
                this.buf = this.buf.subarray(idx);
                this.state = 'seek';
                this.emit(contentType, this.headers, body);
                continue;
            }
            return; // 'skip'
        }
    }
    processRaw() {
        for (;;) {
            const idx = this.buf.indexOf(CLOSE_TAG);
            if (idx < 0) {
                if (this.buf.length > this.maxPart) {
                    this.opts.onError('No complete XML alert within size limit; dropped');
                    this.buf = Buffer.alloc(0);
                }
                return;
            }
            const endPos = idx + CLOSE_TAG.length;
            const start = this.buf.lastIndexOf(OPEN_TAG, idx);
            const body = this.buf.subarray(start >= 0 ? start : 0, endPos);
            this.buf = this.buf.subarray(endPos);
            this.emit('application/xml', {}, body);
        }
    }
}
exports.EventStreamParser = EventStreamParser;
