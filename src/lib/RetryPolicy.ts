/** Exponential backoff with jitter and a hard maximum delay. */
export class RetryPolicy {
    private attempt = 0;

    constructor(
        private readonly baseMs: number,
        private readonly maxMs: number,
        private readonly random: () => number = Math.random,
    ) {}

    next(): number {
        const exp = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
        this.attempt = Math.min(this.attempt + 1, 30);
        const jitter = 0.8 + 0.4 * this.random();
        return Math.max(1, Math.round(Math.min(this.maxMs, exp * jitter)));
    }

    reset(): void {
        this.attempt = 0;
    }
}
