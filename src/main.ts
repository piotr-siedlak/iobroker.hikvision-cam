import * as utils from '@iobroker/adapter-core';
import { CameraRuntime } from './lib/CameraRuntime';
import { normalizeCameras } from './lib/config';
import type { IoApi, LogApi } from './lib/io';

class HikvisionCam extends utils.Adapter {
    private runtimes: CameraRuntime[] = [];

    constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'hikvision-cam' });
        this.on('ready', () => void this.onReady());
        this.on('unload', callback => void this.onUnload(callback));
    }

    private async onReady(): Promise<void> {
        await this.setStateAsync('info.connection', false, true);

        const rows = (this.config as { cameras?: unknown }).cameras;
        // Admin encrypts the password column (jsonConfig table "encryptedAttributes").
        const decrypted = Array.isArray(rows)
            ? rows.map((row: Record<string, unknown>) =>
                  typeof row?.password === 'string' && row.password ? { ...row, password: this.decrypt(row.password) } : row,
              )
            : rows;
        const { cameras, errors } = normalizeCameras(decrypted);
        for (const e of errors) {
            this.log.error(e);
        }
        if (!cameras.length) {
            this.log.info('No enabled cameras configured - add a camera in the adapter settings');
            return;
        }

        const io = this.makeIo();
        const log: LogApi = {
            debug: m => this.log.debug(m),
            info: m => this.log.info(m),
            warn: m => this.log.warn(m),
            error: m => this.log.error(m),
        };

        for (const cfg of cameras) {
            try {
                const runtime = new CameraRuntime(cfg, io, log, {
                    onConnectionChange: () => void this.updateConnection(),
                });
                await runtime.init();
                this.runtimes.push(runtime);
                runtime.start();
            } catch (err) {
                // one broken camera must never prevent the others from running
                this.log.error(`[${cfg.id}] failed to start: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    private async updateConnection(): Promise<void> {
        await this.setStateAsync('info.connection', this.runtimes.some(r => r.isConnected()), true);
    }

    private makeIo(): IoApi {
        return {
            extendObject: async (id, obj) => {
                await this.extendObjectAsync(id, obj as ioBroker.PartialObject);
            },
            setState: async (id, val, opts) => {
                if (opts?.force) {
                    await this.setStateAsync(id, { val, ack: true });
                } else {
                    await this.setStateChangedAsync(id, { val, ack: true });
                }
            },
            getNumber: async id => {
                const s = await this.getStateAsync(id);
                return typeof s?.val === 'number' ? s.val : undefined;
            },
            listStates: async prefix => {
                const ns = `${this.namespace}.`;
                const res = await this.getObjectViewAsync('system', 'state', {
                    startkey: `${ns}${prefix}`,
                    endkey: `${ns}${prefix}香`,
                });
                return res.rows.map(r => r.id.slice(ns.length));
            },
        };
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            await Promise.all(this.runtimes.map(r => r.stop()));
            await this.setStateAsync('info.connection', false, true);
        } catch {
            // ignore errors during shutdown
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HikvisionCam(options);
} else {
    (() => new HikvisionCam())();
}
