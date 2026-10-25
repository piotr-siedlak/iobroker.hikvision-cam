import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AuthError, basicHeader, DigestAuth, parseWwwAuthenticate } from '../src/lib/Authentication';
import { normalizeCameras } from '../src/lib/config';
import { RetryPolicy } from '../src/lib/RetryPolicy';
import { redact, sanitizeId, validateHost } from '../src/lib/util';

describe('Digest authentication', () => {
    it('matches the RFC 2617 example', () => {
        const [c] = parseWwwAuthenticate(
            'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
        );
        const auth = new DigestAuth('Mufasa', 'Circle Of Life', c.params);
        const header = auth.authorize('GET', '/dir/index.html', '0a4f113b');
        assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
        assert.match(header, /nc=00000001/);
        assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
    });

    it('increments the nonce count', () => {
        const auth = new DigestAuth('u', 'p', { nonce: 'n', realm: 'r', qop: 'auth' });
        auth.authorize('GET', '/');
        assert.match(auth.authorize('GET', '/'), /nc=00000002/);
    });

    it('supports SHA-256 and rejects unknown algorithms', () => {
        const ok = new DigestAuth('u', 'p', { nonce: 'n', realm: 'r', qop: 'auth', algorithm: 'SHA-256' });
        assert.match(ok.authorize('GET', '/'), /algorithm=SHA-256/);
        const bad = new DigestAuth('u', 'p', { nonce: 'n', realm: 'r', algorithm: 'SHA-512-256' });
        assert.throws(() => bad.authorize('GET', '/'), AuthError);
    });

    it('rejects header-injection in the username', () => {
        assert.throws(() => new DigestAuth('a"b', 'p', { nonce: 'n' }), AuthError);
        assert.throws(() => basicHeader('a\r\nX: y', 'p'), AuthError);
    });
});

describe('util', () => {
    it('sanitizes object ids', () => {
        assert.equal(sanitizeId('Front Gate #1'), 'front_gate_1');
        assert.equal(sanitizeId('...'), 'unknown');
    });
    it('validates hosts', () => {
        assert.equal(validateHost('192.168.1.64'), undefined);
        assert.equal(validateHost('cam-1.local'), undefined);
        assert.equal(validateHost('fe80::1'), undefined);
        assert.ok(validateHost('http://x'));
        assert.ok(validateHost('a b'));
        assert.ok(validateHost('user@host'));
        assert.ok(validateHost('169.254.169.254'));
    });
    it('redacts secrets', () => {
        assert.equal(redact('failed for hunter2 at x', ['hunter2']), 'failed for *** at x');
        assert.match(redact('Authorization: Digest abc', []), /\*\*\*/);
    });
});

describe('RetryPolicy', () => {
    it('backs off exponentially, caps and resets', () => {
        const r = new RetryPolicy(1000, 8000, () => 0.5); // jitter factor 1.0
        assert.deepEqual([r.next(), r.next(), r.next(), r.next(), r.next()], [1000, 2000, 4000, 8000, 8000]);
        r.reset();
        assert.equal(r.next(), 1000);
    });
});

describe('config', () => {
    it('applies defaults, sanitizes ids and de-duplicates them', () => {
        const { cameras, errors } = normalizeCameras([
            { name: 'Front Gate', host: '192.168.1.10', username: 'a', password: 'b' },
            { name: 'Front Gate', host: '192.168.1.11', protocol: 'https' },
            { name: 'Off', host: '192.168.1.12', enabled: false },
            { name: 'Bad', host: 'http://nope' },
        ]);
        assert.equal(errors.length, 1);
        assert.deepEqual(
            cameras.map(c => [c.id, c.port, c.https]),
            [
                ['front_gate', 80, false],
                ['front_gate_2', 443, true],
            ],
        );
        assert.equal(cameras[0].alarmTimeoutMs, 5000);
        assert.equal(cameras[0].authMode, 'digest');
    });
});
