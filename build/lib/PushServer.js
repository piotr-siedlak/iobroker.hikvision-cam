"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PushServer = void 0;
const promises_1 = require("node:dns/promises");
const http = __importStar(require("node:http"));
const node_net_1 = require("node:net");
const EventStreamParser_1 = require("./EventStreamParser");
const util_1 = require("./util");
const RESOLVE_INTERVAL_MS = 60_000;
function normalizeAddress(addr) {
    const a = addr.toLowerCase();
    return a.startsWith('::ffff:') && (0, node_net_1.isIP)(a.slice(7)) === 4 ? a.slice(7) : a;
}
async function defaultResolve(host) {
    if ((0, node_net_1.isIP)(host)) {
        return [host];
    }
    const res = await (0, promises_1.lookup)(host, { all: true });
    return res.map(r => r.address);
}
/**
 * Minimal receiver for camera-initiated alarm pushes. Only requests from the
 * IP addresses of configured push cameras are accepted; everything else gets
 * HTTP 403. Bodies are parsed incrementally with hard size and time limits.
 * The server never forwards, stores or answers with any data.
 */
class PushServer {
    opts;
    server;
    targets = [];
    byAddress = new Map();
    lastResolve = 0;
    rejected = new Set();
    maxRequest;
    maxSingle;
    resolve;
    constructor(opts) {
        this.opts = opts;
        this.maxRequest = opts.maxRequestBytes ?? 8 * 1024 * 1024;
        this.maxSingle = opts.maxSingleBodyBytes ?? 256 * 1024;
        this.resolve = opts.resolve ?? defaultResolve;
    }
    add(target) {
        this.targets.push(target);
    }
    /** Starts listening; resolves with the bound port. */
    async start() {
        await this.refreshAddresses();
        const server = http.createServer((req, res) => void this.handle(req, res));
        server.maxConnections = 64;
        server.headersTimeout = 10_000;
        server.requestTimeout = 30_000;
        server.keepAliveTimeout = 5_000;
        this.server = server;
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.opts.port, this.opts.bind || undefined, () => {
                server.off('error', reject);
                resolve();
            });
        });
        server.on('error', err => this.opts.log.error(`Push listener error: ${(0, util_1.describeError)(err)}`));
        return server.address().port;
    }
    async stop() {
        const server = this.server;
        this.server = undefined;
        if (!server) {
            return;
        }
        server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
    }
    async refreshAddresses() {
        this.lastResolve = Date.now();
        const map = new Map();
        for (const t of this.targets) {
            try {
                for (const a of await this.resolve(t.host)) {
                    map.set(normalizeAddress(a), t);
                }
            }
            catch (err) {
                this.opts.log.warn(`[${t.id}] cannot resolve ${t.host} for push mode: ${(0, util_1.describeError)(err)}`);
            }
        }
        this.byAddress = map;
    }
    async handle(req, res) {
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
    receive(target, req, res) {
        const contentType = String(req.headers['content-type'] ?? '');
        const boundary = /boundary="?([^";\s]+)"?/i.exec(contentType)?.[1];
        let total = 0;
        let aborted = false;
        const chunks = [];
        const parser = boundary
            ? new EventStreamParser_1.EventStreamParser({
                boundary,
                onPart: part => target.onPart(part),
                onError: msg => target.onParseError(msg),
            })
            : undefined;
        req.on('data', (chunk) => {
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
            }
            else {
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
                }
                catch (err) {
                    target.onParseError((0, util_1.describeError)(err));
                }
            }
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK');
        });
        req.on('error', () => {
            aborted = true;
        });
    }
}
exports.PushServer = PushServer;
