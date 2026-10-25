"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetryPolicy = void 0;
/** Exponential backoff with jitter and a hard maximum delay. */
class RetryPolicy {
    baseMs;
    maxMs;
    random;
    attempt = 0;
    constructor(baseMs, maxMs, random = Math.random) {
        this.baseMs = baseMs;
        this.maxMs = maxMs;
        this.random = random;
    }
    next() {
        const exp = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
        this.attempt = Math.min(this.attempt + 1, 30);
        const jitter = 0.8 + 0.4 * this.random();
        return Math.max(1, Math.round(Math.min(this.maxMs, exp * jitter)));
    }
    reset() {
        this.attempt = 0;
    }
}
exports.RetryPolicy = RetryPolicy;
