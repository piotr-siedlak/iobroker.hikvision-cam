"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionManager = void 0;
const EventStreamParser_1 = require("./EventStreamParser");
const EventNormalizer_1 = require("./EventNormalizer");
const util_1 = require("./util");
/** Owns the connection lifecycle of exactly one camera. */
class ConnectionManager {
    o;
    running = false;
    generation = 0;
    handle;
    timer;
    live = false;
    authFailures = 0;
    constructor(o) {
        this.o = o;
    }
    start() {
        if (this.running) {
            return;
        }
        this.running = true;
        this.connect();
    }
    stop() {
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
    connect() {
        if (!this.running) {
            return;
        }
        const gen = ++this.generation;
        const cb = this.o.callbacks;
        cb.onState('connecting', 'Connecting');
        this.live = false;
        let parser;
        this.handle = this.o.opener.open({
            onOpen: info => {
                if (gen !== this.generation) {
                    return;
                }
                this.authFailures = 0;
                parser = new EventStreamParser_1.EventStreamParser({
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
    onPart(gen, part) {
        if (gen !== this.generation) {
            return;
        }
        const cb = this.o.callbacks;
        let event;
        try {
            const fields = (0, EventNormalizer_1.parsePart)(part);
            if (!fields) {
                return; // image or unknown binary part
            }
            if (this.o.capture && cb.onRaw) {
                cb.onRaw(part.body.toString('utf8', 0, 2000));
            }
            event = (0, EventNormalizer_1.fieldsToEvent)(fields, this.o.cameraId, new Date().toISOString(), {
                discoverUnknown: this.o.discoverUnknown,
            });
        }
        catch (err) {
            cb.onParseError((0, util_1.describeError)(err));
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
    onClosed(failure) {
        const cb = this.o.callbacks;
        this.live = false;
        cb.onDisconnected(failure.message, failure.kind);
        if (!this.running) {
            return;
        }
        let delay;
        switch (failure.kind) {
            case 'auth':
                this.authFailures++;
                cb.onState('authFailed', failure.message);
                if (this.authFailures >= this.o.maxAuthFailures) {
                    cb.onState('authFailed', `${failure.message}. Giving up after ${this.authFailures} attempts to protect the camera account; fix the credentials and restart the instance`);
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
exports.ConnectionManager = ConnectionManager;
