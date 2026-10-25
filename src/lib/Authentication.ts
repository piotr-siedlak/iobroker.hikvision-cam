import { createHash, randomBytes } from 'node:crypto';

export class AuthError extends Error {}

export interface Challenge {
    scheme: 'digest' | 'basic' | string;
    params: Record<string, string>;
}

/** Parse one or more WWW-Authenticate header values. */
export function parseWwwAuthenticate(header: string | string[] | undefined): Challenge[] {
    if (!header) {
        return [];
    }
    const values = Array.isArray(header) ? header : [header];
    const out: Challenge[] = [];
    for (const value of values) {
        const m = /^\s*([A-Za-z]+)\s+([\s\S]*)$/.exec(value);
        if (!m) {
            continue;
        }
        const params: Record<string, string> = {};
        const re = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|([^\s,]+))/g;
        let p: RegExpExecArray | null;
        while ((p = re.exec(m[2])) !== null) {
            params[p[1].toLowerCase()] = p[2] ?? p[3];
        }
        out.push({ scheme: m[1].toLowerCase(), params });
    }
    return out;
}

function assertHeaderSafe(value: string, what: string): void {
    if (/["\r\n]/.test(value)) {
        throw new AuthError(`${what} contains characters that are not allowed in HTTP authentication`);
    }
}

export function basicHeader(username: string, password: string): string {
    assertHeaderSafe(username, 'Username');
    return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/** HTTP Digest (RFC 7616 / 2617): MD5, MD5-sess, SHA-256, SHA-256-sess with qop=auth. */
export class DigestAuth {
    private nc = 0;

    constructor(
        private readonly username: string,
        private readonly password: string,
        private readonly challenge: Record<string, string>,
    ) {
        assertHeaderSafe(username, 'Username');
        if (!challenge.nonce) {
            throw new AuthError('Digest challenge has no nonce');
        }
    }

    authorize(method: string, uri: string, cnonceOverride?: string): string {
        const ch = this.challenge;
        const algorithm = (ch.algorithm ?? 'MD5').toUpperCase();
        const sess = algorithm.endsWith('-SESS');
        const base = sess ? algorithm.slice(0, -5) : algorithm;
        if (base !== 'MD5' && base !== 'SHA-256') {
            throw new AuthError(`Unsupported digest algorithm ${algorithm}`);
        }
        const hash = (s: string): string => createHash(base === 'MD5' ? 'md5' : 'sha256').update(s).digest('hex');

        const qops = (ch.qop ?? '').split(',').map(q => q.trim().toLowerCase());
        const useQop = qops.includes('auth');
        if (ch.qop && !useQop) {
            throw new AuthError('Digest challenge only offers unsupported qop values');
        }

        const realm = ch.realm ?? '';
        const cnonce = cnonceOverride ?? randomBytes(8).toString('hex');
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
