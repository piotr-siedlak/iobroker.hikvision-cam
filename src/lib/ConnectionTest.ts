import { CameraClient, DEVICE_INFO_PATH, RequestError } from './CameraClient';
import type { StreamHandle } from './CameraClient';
import { normalizeCameras } from './config';
import { describeError, redact } from './util';
import { flattenXml, parseXml } from './xml';

export interface TestResult {
    ok: boolean;
    message: string;
}

export interface TestOptions {
    /** How long to wait for each step. Default 10 s. */
    timeoutMs?: number;
}

/**
 * Read-only connection check for one camera row from the admin table:
 * 1. validates the settings,
 * 2. GET /ISAPI/System/deviceInfo (credentials, model, firmware),
 * 3. opens the alertStream and closes it as soon as the camera answers HTTP 200.
 * It stops at the first authentication failure, so one test uses at most one
 * rejected login, and it never sends anything to the camera except GET requests.
 */
export async function testCamera(row: unknown, opts: TestOptions = {}): Promise<TestResult> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const raw = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    // Admin placeholders deliver strings ("true"/"false"/"undefined") for booleans.
    const input = {
        ...raw,
        enabled: true,
        name: String(raw.name ?? '').trim() || 'test',
        verifyTls: !(raw.verifyTls === false || raw.verifyTls === 'false'),
    };
    const { cameras, errors } = normalizeCameras([input]);
    const cam = cameras[0];
    if (!cam) {
        return { ok: false, message: (errors[0] ?? 'Invalid camera settings').replace(/^Camera #1 \([^)]*\): /, '') };
    }
    const secrets = [cam.password];
    const fail = (lines: string[], err: unknown): TestResult => ({
        ok: false,
        message: [...lines, redact(describeError(err), secrets)].join('\n'),
    });

    if (!cam.username) {
        return cam.mode === 'push'
            ? {
                  ok: true,
                  message:
                      'Settings are valid. Push mode without credentials: ISAPI cannot be checked from here. Trigger a rule on the camera and watch info.status.',
              }
            : { ok: false, message: 'User name is missing' };
    }

    const client = new CameraClient({
        host: cam.host,
        port: cam.port,
        https: cam.https,
        username: cam.username,
        password: cam.password,
        authMode: cam.authMode,
        verifyTls: cam.verifyTls,
        connectTimeoutMs: timeoutMs,
        streamIdleTimeoutMs: 0,
    });
    const lines: string[] = [];

    try {
        const fields = new Map<string, string>();
        flattenXml(parseXml(await client.getText(DEVICE_INFO_PATH)), fields);
        const model = fields.get('model') ?? 'unknown model';
        const fw = fields.get('firmwareversion');
        lines.push(`Camera reachable, credentials OK: ${model}${fw ? `, firmware ${fw}` : ''}`);
    } catch (err) {
        if (err instanceof RequestError && err.kind === 'forbidden') {
            lines.push('Credentials OK; reading device info is not permitted for this user (not required)');
        } else if (err instanceof RequestError) {
            return fail([], err);
        } else {
            lines.push('Camera reachable; device info could not be parsed (not required)');
        }
    }

    if (cam.mode === 'push') {
        lines.push('Push mode: alerts arrive when the camera posts to the push listener (Alarm Server / HTTP Listening).');
        return { ok: true, message: lines.join('\n') };
    }

    const stream = await probeStream(client, timeoutMs);
    if (!stream.ok) {
        return fail(lines, `Event stream: ${stream.message}`);
    }
    lines.push('Event stream (ISAPI alertStream) accepted the connection.');
    lines.push("If events still do not arrive, tick 'Notify Surveillance Center' in each rule's linkage.");
    return { ok: true, message: lines.join('\n') };
}

function probeStream(client: CameraClient, timeoutMs: number): Promise<TestResult> {
    return new Promise(resolve => {
        let done = false;
        const finish = (r: TestResult): void => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            // stream callbacks are always asynchronous, so `handle` is assigned by now
            handle.close();
            resolve(r);
        };
        const timer = setTimeout(() => finish({ ok: false, message: `no answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
        const handle: StreamHandle = client.open({
            onOpen: () => finish({ ok: true, message: 'ok' }),
            onData: () => undefined,
            onClose: f => finish({ ok: false, message: f.message }),
        });
    });
}
