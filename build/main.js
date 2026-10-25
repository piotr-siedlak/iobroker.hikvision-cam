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
const ConnectionTest_1 = require("./lib/ConnectionTest");
const Discovery_1 = require("./lib/Discovery");
const config_1 = require("./lib/config");
const PushServer_1 = require("./lib/PushServer");
class HikvisionCam extends utils.Adapter {
    runtimes = [];
    pushServer;
    testsRunning = new Set();
    scanRunning = false;
    constructor(options = {}) {
        super({ ...options, name: 'hikvision-cam' });
        this.on('ready', () => void this.onReady());
        this.on('unload', callback => void this.onUnload(callback));
        this.on('message', obj => void this.onMessage(obj));
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
        if (cameras.some(c => c.snapshot)) {
            await this.setObjectNotExistsAsync('snapshots', {
                type: 'meta',
                common: { name: 'Snapshots', type: 'meta.user' },
                native: {},
            });
        }
        const historySize = (0, config_1.normalizeHistorySize)(this.config.historySize);
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
                    historySize,
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
    /** Admin "Test connection" button (sendTo command `testConnection`) with the row's current values. */
    async onMessage(obj) {
        if (obj?.callback && obj.command === 'discover') {
            await this.onDiscover(obj);
            return;
        }
        if (!obj?.callback || obj.command !== 'testConnection') {
            return;
        }
        const reply = (payload) => {
            this.sendTo(obj.from, obj.command, payload, obj.callback);
        };
        let row = obj.message;
        if (typeof row === 'string') {
            try {
                row = JSON.parse(row);
            }
            catch {
                reply({ error: 'Could not read the camera row. Save the settings and try again.' });
                return;
            }
        }
        const key = String(row?.host ?? '');
        if (this.testsRunning.has(key)) {
            reply({ error: 'A test for this camera is already running' });
            return;
        }
        this.testsRunning.add(key);
        try {
            const res = await (0, ConnectionTest_1.testCamera)(row);
            this.log.info(`Connection test for ${key || 'camera'}: ${res.ok ? 'OK' : 'failed'}`);
            reply(res.ok ? { result: res.message } : { error: res.message });
        }
        catch (err) {
            reply({ error: err instanceof Error ? err.message : String(err) });
        }
        finally {
            this.testsRunning.delete(key);
        }
    }
    /**
     * Admin "Scan and add cameras": scans a private subnet with one set of
     * credentials, appends new cameras to the saved configuration (passwords
     * encrypted like the admin table does) and asks the admin page to reload.
     * Saving the instance configuration restarts the adapter.
     */
    async onDiscover(obj) {
        const reply = (payload) => {
            this.sendTo(obj.from, obj.command, payload, obj.callback);
        };
        if (this.scanRunning) {
            reply({ error: 'A scan is already running' });
            return;
        }
        let msg;
        try {
            msg = (typeof obj.message === 'string' ? JSON.parse(obj.message) : obj.message);
        }
        catch {
            reply({ error: 'Could not read the scan settings. Save the settings and try again.' });
            return;
        }
        const https = String(msg?.protocol ?? 'http').toLowerCase() === 'https';
        const port = parseInt(String(msg?.port ?? ''), 10) || (https ? 443 : 80);
        const username = String(msg?.username ?? '').trim();
        const password = String(msg?.password ?? '');
        const { hosts, error } = (0, Discovery_1.expandTargets)(String(msg?.subnet ?? ''));
        if (error) {
            reply({ error });
            return;
        }
        if (!username || username === 'undefined') {
            reply({ error: 'Enter the user name the cameras share' });
            return;
        }
        if (port < 1 || port > 65535) {
            reply({ error: 'Invalid port' });
            return;
        }
        this.scanRunning = true;
        try {
            const req = { subnet: String(msg.subnet), https, port, username, password };
            this.log.info(`Scanning ${hosts.length} address(es) for Hikvision cameras on port ${port}`);
            const result = await (0, Discovery_1.scanHosts)(hosts, req);
            const instanceId = `system.adapter.${this.namespace}`;
            const instance = await this.getForeignObjectAsync(instanceId);
            if (!instance) {
                reply({ error: 'Instance configuration not found' });
                return;
            }
            const existing = Array.isArray(instance.native.cameras) ? instance.native.cameras : [];
            const added = (0, Discovery_1.buildCameraRows)(result.found, existing, req, plain => this.encrypt(plain));
            const summary = (0, Discovery_1.describeScan)(result, added);
            this.log.info(summary);
            if (!added.length) {
                reply({ error: `No new cameras added. ${summary}` });
                return;
            }
            instance.native.cameras = [...existing, ...added];
            instance.native.lastScanResult = `${new Date().toLocaleString()}: ${summary}`;
            await this.setForeignObjectAsync(instanceId, instance);
            reply({ reloadBrowser: true, result: summary });
        }
        catch (err) {
            reply({ error: err instanceof Error ? err.message : String(err) });
        }
        finally {
            this.scanRunning = false;
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
            getString: async (id) => {
                const s = await this.getStateAsync(id);
                return typeof s?.val === 'string' ? s.val : undefined;
            },
            writeFile: async (name, data) => {
                const metaId = `${this.namespace}.snapshots`;
                await this.writeFileAsync(metaId, name, data);
                return `${metaId}/${name}`;
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
