import { sanitizeId, validateHost } from './util';

export interface NormalizedCameraConfig {
    id: string;
    name: string;
    host: string;
    https: boolean;
    port: number;
    username: string;
    password: string;
    authMode: 'digest' | 'basic';
    verifyTls: boolean;
    reconnectIntervalMs: number;
    alarmTimeoutMs: number;
    streamTimeoutMs: number;
    eventFilter: Set<string>;
    discoverUnknown: boolean;
    diagnostic: boolean;
    /** stream = adapter connects to alertStream; push = camera posts alerts to the adapter's listener. */
    mode: 'stream' | 'push';
}

export interface PushSettings {
    port: number;
    bind: string;
}

export function normalizePushSettings(native: Record<string, unknown>): { settings: PushSettings; error?: string } {
    const port = Math.round(num(native.pushPort, 8089, 1, 65535));
    const bind = String(native.pushBind ?? '').trim();
    if (bind && bind !== '0.0.0.0' && bind !== '::' && validateHost(bind)) {
        return { settings: { port, bind: '' }, error: `Invalid push bind address "${bind}"; listening on all interfaces` };
    }
    return { settings: { port, bind: bind === '0.0.0.0' ? '' : bind } };
}

function num(value: unknown, def: number, min: number, max: number): number {
    const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
    if (!Number.isFinite(n)) {
        return def;
    }
    return Math.min(max, Math.max(min, n));
}

function bool(value: unknown, def: boolean): boolean {
    return typeof value === 'boolean' ? value : def;
}

/** Validate and normalize the camera table from the adapter configuration. */
export function normalizeCameras(rows: unknown): { cameras: NormalizedCameraConfig[]; errors: string[] } {
    const cameras: NormalizedCameraConfig[] = [];
    const errors: string[] = [];
    const usedIds = new Set<string>();
    if (!Array.isArray(rows)) {
        return { cameras, errors };
    }

    rows.forEach((raw: unknown, index) => {
        const row = (raw ?? {}) as Record<string, unknown>;
        const label = `Camera #${index + 1}`;
        if (!bool(row.enabled, true)) {
            return;
        }
        const name = String(row.name ?? '').trim();
        const host = String(row.host ?? '').trim();
        if (!name) {
            errors.push(`${label}: name is missing`);
            return;
        }
        const hostError = validateHost(host);
        if (hostError) {
            errors.push(`${label} (${name}): ${hostError}`);
            return;
        }
        const https = String(row.protocol ?? 'http').toLowerCase() === 'https';
        let id = sanitizeId(name, 32);
        for (let n = 2; usedIds.has(id); n++) {
            id = `${sanitizeId(name, 28)}_${n}`;
        }
        usedIds.add(id);

        const authMode = String(row.authMode ?? 'digest').toLowerCase() === 'basic' ? 'basic' : 'digest';
        cameras.push({
            id,
            name,
            host,
            https,
            port: Math.round(num(row.port, https ? 443 : 80, 1, 65535)),
            username: String(row.username ?? ''),
            password: String(row.password ?? ''),
            authMode,
            verifyTls: bool(row.verifyTls, true),
            reconnectIntervalMs: num(row.reconnectInterval, 5, 1, 3600) * 1000,
            alarmTimeoutMs: num(row.alarmTimeout, 5, 1, 3600) * 1000,
            streamTimeoutMs: num(row.streamTimeout, 60, 15, 3600) * 1000,
            eventFilter: new Set(
                String(row.eventFilter ?? '')
                    .split(',')
                    .map(s => s.trim().toLowerCase())
                    .filter(Boolean),
            ),
            discoverUnknown: bool(row.discoverUnknown, true),
            diagnostic: bool(row.diagnostic, false),
            mode: String(row.mode ?? 'stream').toLowerCase() === 'push' ? 'push' : 'stream',
        });
    });
    return { cameras, errors };
}
