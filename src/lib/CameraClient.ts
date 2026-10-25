import * as http from 'node:http';
import * as https from 'node:https';
import { AuthError, basicHeader, DigestAuth, parseWwwAuthenticate } from './Authentication';
import { describeError, validateHost } from './util';

export const ALERT_STREAM_PATH = '/ISAPI/Event/notification/alertStream';
export const DEVICE_INFO_PATH = '/ISAPI/System/deviceInfo';

export interface ClientConfig {
    host: string;
    port: number;
    https: boolean;
    username: string;
    password: string;
    authMode: 'digest' | 'basic';
    /** Verify the camera's TLS certificate (HTTPS only). */
    verifyTls: boolean;
    connectTimeoutMs: number;
    /**
     * Abort the stream when no data (events or heartbeats) arrives for this long.
     * Only armed after the first data of a session, so cameras that never
     * send heartbeats are not reconnected needlessly.
     */
    streamIdleTimeoutMs: number;
}

export type FailureKind = 'auth' | 'forbidden' | 'unsupported' | 'network' | 'timeout' | 'protocol';

export interface Failure {
    kind: FailureKind;
    message: string;
    status?: number;
}

/** Rejection of getText/getBuffer; keeps the failure kind for diagnostics. */
export class RequestError extends Error {
    constructor(
        readonly kind: FailureKind,
        message: string,
        readonly status?: number,
    ) {
        super(message);
    }
}

export interface StreamHandlers {
    onOpen(info: { contentType: string; boundary?: string }): void;
    onData(chunk: Buffer): void;
    /** Called exactly once when the stream ends or fails (not after close()). */
    onClose(failure: Failure): void;
}

export interface StreamHandle {
    close(): void;
}

export interface StreamOpener {
    open(handlers: StreamHandlers): StreamHandle;
}

interface RequestCallbacks {
    onResponse(res: http.IncomingMessage): void;
    onFail(failure: Failure): void;
}

/**
 * Read-only ISAPI client: only HTTP GET requests, HTTP Digest (or explicitly
 * enabled Basic) authentication. Never logs credentials or auth headers.
 */
export class CameraClient implements StreamOpener {
    constructor(private readonly cfg: ClientConfig) {
        const err = validateHost(cfg.host);
        if (err) {
            throw new Error(err);
        }
        if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
            throw new Error('Invalid port');
        }
    }

    open(handlers: StreamHandlers): StreamHandle {
        let closed = false;
        let idle: NodeJS.Timeout | undefined;
        let gotData = false;

        const clearIdle = (): void => {
            if (idle) {
                clearTimeout(idle);
                idle = undefined;
            }
        };
        const finish = (failure: Failure): void => {
            if (closed) {
                return;
            }
            closed = true;
            clearIdle();
            handle.abort();
            handlers.onClose(failure);
        };
        const armIdle = (): void => {
            clearIdle();
            if (gotData && this.cfg.streamIdleTimeoutMs > 0) {
                idle = setTimeout(
                    () =>
                        finish({
                            kind: 'timeout',
                            message: `No data from camera for ${Math.round(this.cfg.streamIdleTimeoutMs / 1000)} s`,
                        }),
                    this.cfg.streamIdleTimeoutMs,
                );
            }
        };

        const handle = this.request(ALERT_STREAM_PATH, {
            onResponse: res => {
                const contentType = String(res.headers['content-type'] ?? '');
                const boundary = /boundary="?([^";\s]+)"?/i.exec(contentType)?.[1];
                handlers.onOpen({ contentType, boundary });
                res.on('data', (chunk: Buffer) => {
                    gotData = true;
                    armIdle();
                    try {
                        handlers.onData(chunk);
                    } catch {
                        // a faulty consumer must never tear down the connection loop
                    }
                });
                res.on('end', () => finish({ kind: 'network', message: 'Stream closed by camera' }));
                res.on('close', () => finish({ kind: 'network', message: 'Stream closed by camera' }));
                res.on('error', err => finish({ kind: 'network', message: describeError(err) }));
            },
            onFail: finish,
        });

        return {
            close: (): void => {
                closed = true;
                clearIdle();
                handle.abort();
            },
        };
    }

    /** Fetch a small ISAPI document (read-only GET). */
    async getText(path: string, maxBytes = 64 * 1024): Promise<string> {
        return (await this.getBuffer(path, maxBytes)).body.toString('utf8');
    }

    /** Fetch a bounded binary resource, e.g. a JPEG snapshot (read-only GET). */
    getBuffer(path: string, maxBytes: number): Promise<{ body: Buffer; contentType: string }> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn: () => void): void => {
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
                    const contentType = String(res.headers['content-type'] ?? '');
                    const chunks: Buffer[] = [];
                    let size = 0;
                    res.on('data', (d: Buffer) => {
                        size += d.length;
                        if (size > maxBytes) {
                            handle.abort();
                            settle(() => reject(new Error('Response too large')));
                            return;
                        }
                        chunks.push(d);
                    });
                    res.on('end', () => settle(() => resolve({ body: Buffer.concat(chunks), contentType })));
                    res.on('error', err => settle(() => reject(err)));
                },
                onFail: f => settle(() => reject(new RequestError(f.kind, f.message, f.status))),
            });
        });
    }

    private request(path: string, cb: RequestCallbacks): { abort(): void } {
        const cfg = this.cfg;
        let aborted = false;
        let current: http.ClientRequest | undefined;
        let timer: NodeJS.Timeout | undefined;
        let authAttempts = 0;

        const stopTimer = (): void => {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
        };
        const abort = (): void => {
            aborted = true;
            stopTimer();
            current?.destroy();
        };
        const fail = (failure: Failure): void => {
            if (aborted) {
                return;
            }
            abort();
            cb.onFail(failure);
        };

        const attempt = (authorization?: string): void => {
            const headers: Record<string, string> = { Accept: '*/*' };
            if (authorization) {
                headers.Authorization = authorization;
                authAttempts++;
            }
            const options: https.RequestOptions = {
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
            timer = setTimeout(
                () => fail({ kind: 'timeout', message: `No response within ${Math.round(cfg.connectTimeoutMs / 1000)} s` }),
                cfg.connectTimeoutMs,
            );

            req.on('socket', socket => {
                socket.setKeepAlive(true, 15000);
                socket.setNoDelay(true);
            });
            req.on('error', err => {
                if (current === req) {
                    fail({ kind: 'network', message: describeError(err) });
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
                } catch (err) {
                    fail({
                        kind: 'auth',
                        message: err instanceof AuthError ? err.message : describeError(err),
                        status,
                    });
                }
            });
            req.end();
        };

        const handleStatus = (status: number, res: http.IncomingMessage, hadAuth: boolean): void => {
            if (status === 401) {
                const challenges = parseWwwAuthenticate(res.headers['www-authenticate']);
                const digest = challenges.find(c => c.scheme === 'digest');
                const basic = challenges.find(c => c.scheme === 'basic');
                if (!hadAuth) {
                    if (digest) {
                        attempt(new DigestAuth(cfg.username, cfg.password, digest.params).authorize('GET', path));
                    } else if (basic) {
                        fail({
                            kind: 'auth',
                            status,
                            message:
                                'Camera only offers Basic authentication. Switch the camera to Digest, or set the authentication mode to Basic (credentials are then sent unencrypted over HTTP).',
                        });
                    } else {
                        fail({ kind: 'auth', status, message: 'Camera requested an unsupported authentication scheme' });
                    }
                    return;
                }
                if (digest?.params.stale?.toLowerCase() === 'true' && authAttempts < 2) {
                    attempt(new DigestAuth(cfg.username, cfg.password, digest.params).authorize('GET', path));
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
                    message:
                        'Camera busy (HTTP 503): the alertStream client limit may be reached - close other clients (iVMS, NVR, other integrations)',
                });
                return;
            }
            fail({ kind: 'protocol', status, message: `Unexpected HTTP status ${status}` });
        };

        try {
            attempt(cfg.authMode === 'basic' ? basicHeader(cfg.username, cfg.password) : undefined);
        } catch (err) {
            setImmediate(() => fail({ kind: 'auth', message: describeError(err) }));
        }
        return { abort };
    }
}
