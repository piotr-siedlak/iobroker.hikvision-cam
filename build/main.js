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
const utils = __importStar(require("@iobroker/adapter-core"));
const CameraRuntime_1 = require("./lib/CameraRuntime");
const config_1 = require("./lib/config");
const PushServer_1 = require("./lib/PushServer");
class HikvisionCam extends utils.Adapter {
    runtimes = [];
    pushServer;
    constructor(options = {}) {
        super({ ...options, name: 'hikvision-cam' });
        this.on('ready', () => void this.onReady());
        this.on('unload', callback => void this.onUnload(callback));
    }
    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        const rows = this.config.cameras;
        // Admin encrypts the password column (jsonConfig table "encryptedAttributes").
        const decrypted = Array.isArray(rows)
            ? rows.map((row) => typeof row?.password === 'string' && row.password ? { ...row, password: this.decrypt(row.password) } : row)
            : rows;
        const { cameras, errors } = (0, config_1.normalizeCameras)(decrypted);
        for (const e of errors) {
            this.log.error(e);
        }
        if (!cameras.length) {
            this.log.info('No enabled cameras configured - add a camera in the adapter settings');
            return;
        }
        const io = this.makeIo();
        const log = {
            debug: m => this.log.debug(m),
            info: m => this.log.info(m),
            warn: m => this.log.warn(m),
            error: m => this.log.error(m),
        };
        for (const cfg of cameras) {
            try {
                const runtime = new CameraRuntime_1.CameraRuntime(cfg, io, log, {
                    onConnectionChange: () => void this.updateConnection(),
                });
                await runtime.init();
                this.runtimes.push(runtime);
                runtime.start();
            }
            catch (err) {
                // one broken camera must never prevent the others from running
                this.log.error(`[${cfg.id}] failed to start: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        await this.startPushServer(log, cameras.filter(c => c.mode === 'push').map(c => c.id));
    }
    async startPushServer(log, pushIds) {
        const pushRuntimes = this.runtimes.filter(r => pushIds.includes(r.id));
        if (!pushRuntimes.length) {
            return;
        }
        const { settings, error } = (0, config_1.normalizePushSettings)(this.config);
        if (error) {
            this.log.warn(error);
        }
        const server = new PushServer_1.PushServer({ port: settings.port, bind: settings.bind, log });
        for (const r of pushRuntimes) {
            server.add(r.pushTarget());
        }
        try {
            const port = await server.start();
            this.pushServer = server;
            this.log.info(`Push listener on ${settings.bind || 'all interfaces'}:${port} for ${pushRuntimes.length} camera(s)`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.error(`Push listener could not start on port ${settings.port}: ${msg}`);
            for (const r of pushRuntimes) {
                r.setPushListenerError(msg);
            }
        }
    }
    async updateConnection() {
        await this.setStateAsync('info.connection', this.runtimes.some(r => r.isConnected()), true);
    }
    makeIo() {
        return {
            extendObject: async (id, obj) => {
                await this.extendObjectAsync(id, obj);
            },
            setState: async (id, val, opts) => {
                if (opts?.force) {
                    await this.setStateAsync(id, { val, ack: true });
                }
                else {
                    await this.setStateChangedAsync(id, { val, ack: true });
                }
            },
            getNumber: async (id) => {
                const s = await this.getStateAsync(id);
                return typeof s?.val === 'number' ? s.val : undefined;
            },
            listStates: async (prefix) => {
                const ns = `${this.namespace}.`;
                const res = await this.getObjectViewAsync('system', 'state', {
                    startkey: `${ns}${prefix}`,
                    endkey: `${ns}${prefix}香`,
                });
                return res.rows.map(r => r.id.slice(ns.length));
            },
        };
    }
    async onUnload(callback) {
        try {
            await this.pushServer?.stop();
            await Promise.all(this.runtimes.map(r => r.stop()));
            await this.setStateAsync('info.connection', false, true);
        }
        catch {
            // ignore errors during shutdown
        }
        finally {
            callback();
        }
    }
}
if (require.main !== module) {
    module.exports = (options) => new HikvisionCam(options);
}
else {
    (() => new HikvisionCam())();
}
