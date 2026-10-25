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
exports.CameraClient = exports.DEVICE_INFO_PATH = exports.ALERT_STREAM_PATH = void 0;
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const Authentication_1 = require("./Authentication");
const util_1 = require("./util");
exports.ALERT_STREAM_PATH = '/ISAPI/Event/notification/alertStream';
exports.DEVICE_INFO_PATH = '/ISAPI/System/deviceInfo';
/**
 * Read-only ISAPI client: only HTTP GET requests, HTTP Digest (or explicitly
 * enabled Basic) authentication. Never logs credentials or auth headers.
 */
class CameraClient {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
        const err = (0, util_1.validateHost)(cfg.host);
        if (err) {
            throw new Error(err);
        }
        if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
            throw new Error('Invalid port');
        }
    }
    open(handlers) {
        let closed = false;
        let idle;
        let gotData = false;
        const clearIdle = () => {
            if (idle) {
                clearTimeout(idle);
                idle = undefined;
            }
        };
        const finish = (failure) => {
            if (closed) {
                return;
            }
            closed = true;
            clearIdle();
            handle.abort();
            handlers.onClose(failure);
        };
        const armIdle = () => {
            clearIdle();
            if (gotData && this.cfg.streamIdleTimeoutMs > 0) {
                idle = setTimeout(() => finish({
                    kind: 'timeout',
                    message: `No data from camera for ${Math.round(this.cfg.streamIdleTimeoutMs / 1000)} s`,
                }), this.cfg.streamIdleTimeoutMs);
            }
        };
        const handle = this.request(exports.ALERT_STREAM_PATH, {
            onResponse: res => {
                const contentType = String(res.headers['content-type'] ?? '');
                const boundary = /boundary="?([^";\s]+)"?/i.exec(contentType)?.[1];
                handlers.onOpen({ contentType, boundary });
                res.on('data', (chunk) => {
                    gotData = true;
                    armIdle();
                    try {
                        handlers.onData(chunk);
                    }
                    catch {
                        // a faulty consumer must never tear down the connection loop
                    }
                });
                res.on('end', () => finish({ kind: 'network', message: 'Stream closed by camera' }));
                res.on('close', () => finish({ kind: 'network', message: 'Stream closed by camera' }));
                res.on('error', err => finish({ kind: 'network', message: (0, util_1.describeError)(err) }));
            },
            onFail: finish,
        });
        return {
            close: () => {
                closed = true;
                clearIdle();
                handle.abort();
            },
        };
    }
    /** Fetch a small ISAPI document (read-only GET). */
    getText(path, maxBytes = 64 * 1024) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(overall);
                    fn();
                }
            };
            const overall = setTimeout(() => {
                handle.abort();
                settle(() => reject(new Error('Request timed out')));
            }, 15000);
            const handle = this.request(path, {
                onResponse: res => {
                    const chunks = [];
                    let size = 0;
                    res.on('data', (d) => {
                        size += d.length;
                        if (size > maxBytes) {
                            handle.abort();
                            settle(() => reject(new Error('Response too large')));
                            return;
                        }
                        chunks.push(d);
                    });
                    res.on('end', () => settle(() => resolve(Buffer.concat(chunks).toString('utf8'))));
                    res.on('error', err => settle(() => reject(err)));
                },
                onFail: f => settle(() => reject(new Error(f.message))),
            });
        });
    }
    request(path, cb) {
        const cfg = this.cfg;
        let aborted = false;
        let current;
        let timer;
        let authAttempts = 0;
        const stopTimer = () => {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
        };
        const abort = () => {
            aborted = true;
            stopTimer();
            current?.destroy();
        };
        const fail = (failure) => {
            if (aborted) {
                return;
            }
            abort();
            cb.onFail(failure);
        };
        const attempt = (authorization) => {
            const headers = { Accept: '*/*' };
            if (authorization) {
                headers.Authorization = authorization;
                authAttempts++;
            }
            const options = {
                host: cfg.host,
                port: cfg.port,
                path,
                method: 'GET',
                headers,
                agent: false,
            };
            if (cfg.https) {
                options.rejectUnauthorized = cfg.verifyTls;
            }
            const req = (cfg.https ? https : http).request(options);
            current = req;
            stopTimer();
            timer = setTimeout(() => fail({ kind: 'timeout', message: `No response within ${Math.round(cfg.connectTimeoutMs / 1000)} s` }), cfg.connectTimeoutMs);
            req.on('socket', socket => {
                socket.setKeepAlive(true, 15000);
                socket.setNoDelay(true);
            });
            req.on('error', err => {
                if (current === req) {
                    fail({ kind: 'network', message: (0, util_1.describeError)(err) });
                }
            });
            req.on('response', res => {
                if (current !== req || aborted) {
                    res.resume();
                    return;
                }
                stopTimer();
                const status = res.statusCode ?? 0;
                if (status === 200) {
                    cb.onResponse(res);
                    return;
                }
                res.resume();
                try {
                    handleStatus(status, res, authorization !== undefined);
                }
                catch (err) {
                    fail({
                        kind: 'auth',
                        message: err instanceof Authentication_1.AuthError ? err.message : (0, util_1.describeError)(err),
                        status,
                    });
                }
            });
            req.end();
        };
        const handleStatus = (status, res, hadAuth) => {
            if (status === 401) {
                const challenges = (0, Authentication_1.parseWwwAuthenticate)(res.headers['www-authenticate']);
                const digest = challenges.find(c => c.scheme === 'digest');
                const basic = challenges.find(c => c.scheme === 'basic');
                if (!hadAuth) {
                    if (digest) {
                        attempt(new Authentication_1.DigestAuth(cfg.username, cfg.password, digest.params).authorize('GET', path));
                    }
                    else if (basic) {
                        fail({
                            kind: 'auth',
                            status,
                            message: 'Camera only offers Basic authentication. Switch the camera to Digest, or set the authentication mode to Basic (credentials are then sent unencrypted over HTTP).',
                        });
                    }
                    else {
                        fail({ kind: 'auth', status, message: 'Camera requested an unsupported authentication scheme' });
                    }
                    return;
                }
                if (digest?.params.stale?.toLowerCase() === 'true' && authAttempts < 2) {
                    attempt(new Authentication_1.DigestAuth(cfg.username, cfg.password, digest.params).authorize('GET', path));
                    return;
                }
                fail({ kind: 'auth', status, message: 'Authentication failed (HTTP 401): check username and password' });
                return;
            }
            if (status === 403) {
                fail({
                    kind: 'forbidden',
                    status,
                    message: 'Permission denied (HTTP 403): the user needs remote notification/alarm permission',
                });
                return;
            }
            if (status === 404 || status === 405 || status === 501) {
                fail({ kind: 'unsupported', status, message: `ISAPI alertStream is not supported (HTTP ${status})` });
                return;
            }
            if (status === 503) {
                fail({
                    kind: 'protocol',
                    status,
                    message: 'Camera busy (HTTP 503): the alertStream client limit may be reached - close other clients (iVMS, NVR, other integrations)',
                });
                return;
            }
            fail({ kind: 'protocol', status, message: `Unexpected HTTP status ${status}` });
        };
        try {
            attempt(cfg.authMode === 'basic' ? (0, Authentication_1.basicHeader)(cfg.username, cfg.password) : undefined);
        }
        catch (err) {
            setImmediate(() => fail({ kind: 'auth', message: (0, util_1.describeError)(err) }));
        }
        return { abort };
    }
}
exports.CameraClient = CameraClient;
