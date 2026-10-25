/**
 * Suppresses byte-identical notifications that arrive within a very short
 * window (e.g. the same alert delivered twice). The key should include any
 * identifiers the camera provides (event id, camera timestamp, post count),
 * so legitimate consecutive detections are never merged.
 */
export class EventDeduplicator {
    private readonly seen = new Map<string, number>();

    constructor(
        private readonly windowMs = 300,
        private readonly maxEntries = 256,
    ) {}

    isDuplicate(key: string, now: number): boolean {
        const last = this.seen.get(key);
        if (last !== undefined && now - last < this.windowMs) {
            return true;
        }
        this.seen.set(key, now);
        if (this.seen.size > this.maxEntries) {
            for (const [k, t] of this.seen) {
                if (now - t >= this.windowMs) {
                    this.seen.delete(k);
                }
            }
            while (this.seen.size > this.maxEntries) {
                const oldest = this.seen.keys().next().value;
                if (oldest === undefined) {
                    break;
                }
                this.seen.delete(oldest);
            }
        }
        return false;
    }
}
