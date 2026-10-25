"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DigestAuth = exports.AuthError = void 0;
exports.parseWwwAuthenticate = parseWwwAuthenticate;
exports.basicHeader = basicHeader;
const node_crypto_1 = require("node:crypto");
class AuthError extends Error {
}
exports.AuthError = AuthError;
/** Parse one or more WWW-Authenticate header values. */
function parseWwwAuthenticate(header) {
    if (!header) {
        return [];
    }
    const values = Array.isArray(header) ? header : [header];
    const out = [];
    for (const value of values) {
        const m = /^\s*([A-Za-z]+)\s+([\s\S]*)$/.exec(value);
        if (!m) {
            continue;
        }
        const params = {};
        const re = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|([^\s,]+))/g;
        let p;
        while ((p = re.exec(m[2])) !== null) {
            params[p[1].toLowerCase()] = p[2] ?? p[3];
        }
        out.push({ scheme: m[1].toLowerCase(), params });
    }
    return out;
}
function assertHeaderSafe(value, what) {
    if (/["\r\n]/.test(value)) {
        throw new AuthError(`${what} contains characters that are not allowed in HTTP authentication`);
    }
}
function basicHeader(username, password) {
    assertHeaderSafe(username, 'Username');
    return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}
/** HTTP Digest (RFC 7616 / 2617): MD5, MD5-sess, SHA-256, SHA-256-sess with qop=auth. */
class DigestAuth {
    username;
    password;
    challenge;
    nc = 0;
    constructor(username, password, challenge) {
        this.username = username;
        this.password = password;
        this.challenge = challenge;
        assertHeaderSafe(username, 'Username');
        if (!challenge.nonce) {
            throw new AuthError('Digest challenge has no nonce');
        }
    }
    authorize(method, uri, cnonceOverride) {
        const ch = this.challenge;
        const algorithm = (ch.algorithm ?? 'MD5').toUpperCase();
        const sess = algorithm.endsWith('-SESS');
        const base = sess ? algorithm.slice(0, -5) : algorithm;
        if (base !== 'MD5' && base !== 'SHA-256') {
            throw new AuthError(`Unsupported digest algorithm ${algorithm}`);
        }
        const hash = (s) => (0, node_crypto_1.createHash)(base === 'MD5' ? 'md5' : 'sha256').update(s).digest('hex');
        const qops = (ch.qop ?? '').split(',').map(q => q.trim().toLowerCase());
        const useQop = qops.includes('auth');
        if (ch.qop && !useQop) {
            throw new AuthError('Digest challenge only offers unsupported qop values');
        }
        const realm = ch.realm ?? '';
        const cnonce = cnonceOverride ?? (0, node_crypto_1.randomBytes)(8).toString('hex');
        const nc = (++this.nc).toString(16).padStart(8, '0');
        let ha1 = hash(`${this.username}:${realm}:${this.password}`);
        if (sess) {
            ha1 = hash(`${ha1}:${ch.nonce}:${cnonce}`);
        }
        const ha2 = hash(`${method}:${uri}`);
        const response = useQop
            ? hash(`${ha1}:${ch.nonce}:${nc}:${cnonce}:auth:${ha2}`)
            : hash(`${ha1}:${ch.nonce}:${ha2}`);
        const parts = [
            `username="${this.username}"`,
            `realm="${realm}"`,
            `nonce="${ch.nonce}"`,
            `uri="${uri}"`,
            `algorithm=${ch.algorithm ?? 'MD5'}`,
            `response="${response}"`,
        ];
        if (useQop) {
            parts.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
        }
        if (ch.opaque) {
            parts.push(`opaque="${ch.opaque}"`);
        }
        return `Digest ${parts.join(', ')}`;
    }
}
exports.DigestAuth = DigestAuth;
