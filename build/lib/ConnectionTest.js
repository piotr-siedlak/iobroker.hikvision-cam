"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testCamera = testCamera;
const CameraClient_1 = require("./CameraClient");
const config_1 = require("./config");
const util_1 = require("./util");
const xml_1 = require("./xml");
/**
 * Read-only connection check for one camera row from the admin table:
 * 1. validates the settings,
 * 2. GET /ISAPI/System/deviceInfo (credentials, model, firmware),
 * 3. opens the alertStream and closes it as soon as the camera answers HTTP 200.
 * It stops at the first authentication failure, so one test uses at most one
 * rejected login, and it never sends anything to the camera except GET requests.
 */
async function testCamera(row, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const raw = (row && typeof row === 'object' ? row : {});
    // Admin placeholders deliver strings ("true"/"false"/"undefined") for booleans.
    const input = {
        ...raw,
        enabled: true,
        name: String(raw.name ?? '').trim() || 'test',
        verifyTls: !(raw.verifyTls === false || raw.verifyTls === 'false'),
    };
    const { cameras, errors } = (0, config_1.normalizeCameras)([input]);
    const cam = cameras[0];
    if (!cam) {
        return { ok: false, message: (errors[0] ?? 'Invalid camera settings').replace(/^Camera #1 \([^)]*\): /, '') };
    }
    const secrets = [cam.password];
    const fail = (lines, err) => ({
        ok: false,
        message: [...lines, (0, util_1.redact)((0, util_1.describeError)(err), secrets)].join('\n'),
    });
    if (!cam.username) {
        return cam.mode === 'push'
            ? {
                ok: true,
                message: 'Settings are valid. Push mode without credentials: ISAPI cannot be checked from here. Trigger a rule on the camera and watch info.status.',
            }
            : { ok: false, message: 'User name is missing' };
    }
    const client = new CameraClient_1.CameraClient({
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
    const lines = [];
    try {
        const fields = new Map();
        (0, xml_1.flattenXml)((0, xml_1.parseXml)(await client.getText(CameraClient_1.DEVICE_INFO_PATH)), fields);
        const model = fields.get('model') ?? 'unknown model';
        const fw = fields.get('firmwareversion');
        lines.push(`Camera reachable, credentials OK: ${model}${fw ? `, firmware ${fw}` : ''}`);
    }
    catch (err) {
        if (err instanceof CameraClient_1.RequestError && err.kind === 'forbidden') {
            lines.push('Credentials OK; reading device info is not permitted for this user (not required)');
        }
        else if (err instanceof CameraClient_1.RequestError) {
            return fail([], err);
        }
        else {
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
function probeStream(client, timeoutMs) {
    return new Promise(resolve => {
        let done = false;
        const finish = (r) => {
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
        const handle = client.open({
            onOpen: () => finish({ ok: true, message: 'ok' }),
            onData: () => undefined,
            onClose: f => finish({ ok: false, message: f.message }),
        });
    });
}
