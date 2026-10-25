import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isIP } from 'node:net';
import { EventStreamParser } from './EventStreamParser';
import type { LogApi } from './io';
import type { StreamPart } from './types';
import { describeError } from './util';

/** A camera that delivers alerts by HTTP push ("HTTP Listening" / alarm server). */
export interface PushTarget {
    id: string;
    host: string;
    onPart(part: StreamPart): void;
    onParseError(message: string): void;
}

export interface PushServerOptions {
    port: number;
    /** Address to bind; empty = all interfaces. */
    bind: string;
    log: LogApi;
    /** Upper bound for one request body (multipart pushes may carry images). */
    maxRequestBytes?: number;
    /** Upper bound for a non-multipart (single XML/JSON) body. */
    maxSingleBodyBytes?: number;
    /** Injected for tests. */
    resolve?: (host: string) => Promise<string[]>;
}

const RESOLVE_INTERVAL_MS = 60_000;

function normalizeAddress(addr: string): string {
    const a = addr.toLowerCase();
    return a.startsWith('::ffff:') && isIP(a.slice(7)) === 4 ? a.slice(7) : a;
}

async function defaultResolve(host: string): Promise<string[]> {
    if (isIP(host)) {
        return [host];
    }
    const res = await lookup(host, { all: true });
    return res.map(r => r.address);
}

/**
 * Minimal receiver for camera-initiated alarm pushes. Only requests from the
 * IP addresses of configured push cameras are accepted; everything else gets
 * HTTP 403. Bodies are parsed incrementally with hard size and time limits.
 * The server never forwards, stores or answers with any data.
 */
export class PushServer {
    private server: http.Server | undefined;
    private readonly targets: PushTarget[] = [];
    private byAddress = new Map<string, PushTarget>();
    private lastResolve = 0;
    private readonly rejected = new Set<string>();
    private readonly maxRequest: number;
    private readonly maxSingle: number;
    private readonly resolve: (host: string) => Promise<string[]>;

    constructor(private readonly opts: PushServerOptions) {
        this.maxRequest = opts.maxRequestBytes ?? 8 * 1024 * 1024;
        this.maxSingle = opts.maxSingleBodyBytes ?? 256 * 1024;
        this.resolve = opts.resolve ?? defaultResolve;
    }

    add(target: PushTarget): void {
        this.targets.push(target);
    }

    /** Starts listening; resolves with the bound port. */
    async start(): Promise<number> {
        await this.refreshAddresses();
        const server = http.createServer((req, res) => void this.handle(req, res));
        server.maxConnections = 64;
        server.headersTimeout = 10_000;
        server.requestTimeout = 30_000;
        server.keepAliveTimeout = 5_000;
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.opts.port, this.opts.bind || undefined, () => {
                server.off('error', reject);
                resolve();
            });
        });
        server.on('error', err => this.opts.log.error(`Push listener error: ${describeError(err)}`));
        return (server.address() as AddressInfo).port;
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        if (!server) {
            return;
        }
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }

    private async refreshAddresses(): Promise<void> {
        this.lastResolve = Date.now();
        const map = new Map<string, PushTarget>();
        for (const t of this.targets) {
            try {
                for (const a of await this.resolve(t.host)) {
                    map.set(normalizeAddress(a), t);
                }
            } catch (err) {
                this.opts.log.warn(`[${t.id}] cannot resolve ${t.host} for push mode: ${describeError(err)}`);
            }
        }
        this.byAddress = map;
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        req.setTimeout(15_000, () => req.destroy());
        if (req.method !== 'POST' && req.method !== 'PUT') {
            res.writeHead(405, { Allow: 'POST, PUT' }).end();
            req.resume();
            return;
        }
        const addr = normalizeAddress(req.socket.remoteAddress ?? '');
        let target = this.byAddress.get(addr);
        if (!target && Date.now() - this.lastResolve > RESOLVE_INTERVAL_MS) {
            await this.refreshAddresses();
            target = this.byAddress.get(addr);
        }
        if (!target) {
            if (!this.rejected.has(addr) && this.rejected.size < 100) {
                this.rejected.add(addr);
                this.opts.log.warn(`Push from unconfigured address ${addr} rejected (add the camera in push mode to accept it)`);
            }
            res.writeHead(403).end();
            req.resume();
            return;
        }
        this.receive(target, req, res);
    }

    private receive(target: PushTarget, req: http.IncomingMessage, res: http.ServerResponse): void {
        const contentType = String(req.headers['content-type'] ?? '');
        const boundary = /boundary="?([^";\s]+)"?/i.exec(contentType)?.[1];
        let total = 0;
        let aborted = false;
        const chunks: Buffer[] = [];
        const parser = boundary
            ? new EventStreamParser({
                  boundary,
                  onPart: part => target.onPart(part),
                  onError: msg => target.onParseError(msg),
              })
            : undefined;

        req.on('data', (chunk: Buffer) => {
            if (aborted) {
                return;
            }
            total += chunk.length;
            const limit = parser ? this.maxRequest : this.maxSingle;
            if (total > limit) {
                aborted = true;
                target.onParseError(`Push request larger than ${limit} bytes rejected`);
                res.writeHead(413, { Connection: 'close' }).end();
                req.destroy();
                return;
            }
            if (parser) {
                parser.feed(chunk);
            } else {
                chunks.push(chunk);
            }
        });
        req.on('end', () => {
            if (aborted) {
                return;
            }
            if (!parser && total > 0) {
                try {
                    target.onPart({ contentType, headers: {}, body: Buffer.concat(chunks) });
                } catch (err) {
                    target.onParseError(describeError(err));
                }
            }
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK');
        });
        req.on('error', () => {
            aborted = true;
        });
    }
}
