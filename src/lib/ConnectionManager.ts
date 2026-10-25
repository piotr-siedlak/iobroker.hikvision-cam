import type { StreamHandle, StreamOpener, Failure } from './CameraClient';
import { EventStreamParser } from './EventStreamParser';
import { fieldsToEvent, parsePart } from './EventNormalizer';
import type { HikvisionEvent, StreamPart } from './types';
import { RetryPolicy } from './RetryPolicy';
import { describeError } from './util';

export type ConnState =
    | 'idle'
    | 'connecting'
    | 'waiting' // connected, no data yet
    | 'receiving' // connected and data/heartbeats arriving
    | 'lost'
    | 'authFailed'
    | 'denied'
    | 'unsupported';

export interface ManagerCallbacks {
    onState(state: ConnState, detail: string): void;
    /** HTTP stream established (HTTP 200). */
    onConnected(): void;
    /** First parsed alert of a session: the stream is demonstrably alive. */
    onLive(): void;
    onDisconnected(reason: string, kind: Failure['kind']): void;
    onReconnectScheduled(delayMs: number): void;
    onEvent(event: HikvisionEvent): void;
    onParseError(message: string): void;
    /** Raw payload text, only when capture is enabled. */
    onRaw?(text: string): void;
}

export interface ManagerOptions {
    cameraId: string;
    opener: StreamOpener;
    retry: RetryPolicy;
    /** Delay between attempts after an authentication failure (protects the camera account). */
    authRetryMs: number;
    /** After this many consecutive auth failures no further attempts are made. */
    maxAuthFailures: number;
    /** Delay for "unsupported" / "permission denied" conditions. */
    slowRetryMs: number;
    discoverUnknown: boolean;
    capture?: boolean;
    maxBufferBytes?: number;
    maxPartBytes?: number;
    callbacks: ManagerCallbacks;
}

/** Owns the connection lifecycle of exactly one camera. */
export class ConnectionManager {
    private running = false;
    private generation = 0;
    private handle: StreamHandle | undefined;
    private timer: NodeJS.Timeout | undefined;
    private live = false;
    private authFailures = 0;

    constructor(private readonly o: ManagerOptions) {}

    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.connect();
    }

    stop(): void {
        this.running = false;
        this.generation++;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.handle?.close();
        this.handle = undefined;
        this.o.callbacks.onState('idle', 'Stopped');
    }

    private connect(): void {
        if (!this.running) {
            return;
        }
        const gen = ++this.generation;
        const cb = this.o.callbacks;
        cb.onState('connecting', 'Connecting');
        this.live = false;
        let parser: EventStreamParser | undefined;

        this.handle = this.o.opener.open({
            onOpen: info => {
                if (gen !== this.generation) {
                    return;
                }
                this.authFailures = 0;
                parser = new EventStreamParser({
                    boundary: info.boundary,
                    maxBufferBytes: this.o.maxBufferBytes,
                    maxPartBytes: this.o.maxPartBytes,
                    onPart: part => this.onPart(gen, part),
                    onError: msg => cb.onParseError(msg),
                });
                cb.onConnected();
                cb.onState('waiting', 'Connected, waiting for events');
            },
            onData: chunk => {
                if (gen === this.generation) {
                    parser?.feed(chunk);
                }
            },
            onClose: failure => {
                if (gen !== this.generation) {
                    return;
                }
                parser = undefined;
                this.handle = undefined;
                this.onClosed(failure);
            },
        });
    }

    private onPart(gen: number, part: StreamPart): void {
        if (gen !== this.generation) {
            return;
        }
        const cb = this.o.callbacks;
        let event: HikvisionEvent | null;
        try {
            const fields = parsePart(part);
            if (!fields) {
                return; // image or unknown binary part
            }
            if (this.o.capture && cb.onRaw) {
                cb.onRaw(part.body.toString('utf8', 0, 2000));
            }
            event = fieldsToEvent(fields, this.o.cameraId, new Date().toISOString(), {
                discoverUnknown: this.o.discoverUnknown,
            });
        } catch (err) {
            cb.onParseError(describeError(err));
            return;
        }
        if (!this.live) {
            this.live = true;
            this.o.retry.reset();
            cb.onState('receiving', 'Receiving events');
            cb.onLive();
        }
        if (event) {
            cb.onEvent(event);
        }
    }

    private onClosed(failure: Failure): void {
        const cb = this.o.callbacks;
        this.live = false;
        cb.onDisconnected(failure.message, failure.kind);
        if (!this.running) {
            return;
        }

        let delay: number;
        switch (failure.kind) {
            case 'auth':
                this.authFailures++;
                cb.onState('authFailed', failure.message);
                if (this.authFailures >= this.o.maxAuthFailures) {
                    cb.onState(
                        'authFailed',
                        `${failure.message}. Giving up after ${this.authFailures} attempts to protect the camera account; fix the credentials and restart the instance`,
                    );
                    return;
                }
                delay = this.o.authRetryMs;
                break;
            case 'forbidden':
                cb.onState('denied', failure.message);
                delay = Math.max(this.o.retry.next(), this.o.slowRetryMs);
                break;
            case 'unsupported':
                cb.onState('unsupported', failure.message);
                delay = Math.max(this.o.retry.next(), this.o.slowRetryMs);
                break;
            default:
                cb.onState('lost', failure.message);
                delay = this.o.retry.next();
        }
        cb.onReconnectScheduled(delay);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.connect();
        }, delay);
        this.timer.unref?.();
    }
}
