"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CameraRuntime = void 0;
const CameraClient_1 = require("./CameraClient");
const ConnectionManager_1 = require("./ConnectionManager");
const EventStateManager_1 = require("./EventStateManager");
const RetryPolicy_1 = require("./RetryPolicy");
const util_1 = require("./util");
const xml_1 = require("./xml");
const N = (en, pl) => ({ en, pl });
const EVENT_LABELS = {
    motion: N('Motion detection', 'Wykrycie ruchu'),
    line_crossing: N('Line crossing', 'Przekroczenie linii'),
    intrusion: N('Intrusion', 'Wtargnięcie'),
    region_entrance: N('Region entrance', 'Wejście w obszar'),
    region_exit: N('Region exit', 'Wyjście z obszaru'),
    loitering: N('Loitering', 'Włóczenie się'),
    face_detection: N('Face detection', 'Wykrycie twarzy'),
    people_gathering: N('People gathering', 'Gromadzenie się ludzi'),
    unattended_baggage: N('Unattended baggage', 'Porzucony bagaż'),
    object_removal: N('Object removal', 'Usunięcie obiektu'),
    scene_change: N('Scene change', 'Zmiana sceny'),
    tampering: N('Video tampering', 'Sabotaż obrazu'),
    video_loss: N('Video loss', 'Utrata obrazu'),
    defocus: N('Defocus', 'Rozogniskowanie'),
    audio_exception: N('Audio exception', 'Wyjątek audio'),
    pir: N('PIR alarm', 'Alarm PIR'),
    alarm_input: N('Alarm input', 'Wejście alarmowe'),
    system_exception: N('Storage / network exception', 'Wyjątek pamięci / sieci'),
};
const INFO_STATES = [
    { key: 'connection', type: 'boolean', role: 'indicator.connected', name: N('Stream connected', 'Połączenie ze strumieniem') },
    { key: 'streamConnected', type: 'boolean', role: 'indicator.reachable', name: N('Receiving data (events or heartbeat)', 'Odbiór danych (zdarzenia lub heartbeat)') },
    { key: 'status', type: 'string', role: 'text', name: N('Connection status', 'Status połączenia') },
    { key: 'model', type: 'string', role: 'text', name: N('Model', 'Model') },
    { key: 'firmware', type: 'string', role: 'text', name: N('Firmware', 'Oprogramowanie') },
    { key: 'ipAddress', type: 'string', role: 'info.ip', name: N('Address', 'Adres') },
    { key: 'lastSeen', type: 'string', role: 'date', name: N('Last data received', 'Ostatnie dane') },
    { key: 'lastHeartbeat', type: 'string', role: 'date', name: N('Last heartbeat', 'Ostatni heartbeat') },
    { key: 'lastSuccessfulConnection', type: 'string', role: 'date', name: N('Last successful connection', 'Ostatnie udane połączenie') },
    { key: 'lastError', type: 'string', role: 'text', name: N('Last error', 'Ostatni błąd') },
    { key: 'lastEvent', type: 'string', role: 'date', name: N('Last event time', 'Czas ostatniego zdarzenia') },
    { key: 'reconnectCount', type: 'number', role: 'value', name: N('Reconnect count', 'Liczba ponowień połączenia') },
    { key: 'eventsReceived', type: 'number', role: 'value', name: N('Events received', 'Odebrane zdarzenia') },
    { key: 'parseErrors', type: 'number', role: 'value', name: N('Parse errors', 'Błędy analizy') },
];
const LAST_EVENT_STATES = [
    { key: 'type', type: 'string', role: 'text', name: N('Event type', 'Typ zdarzenia') },
    { key: 'rawType', type: 'string', role: 'text', name: N('Raw event type', 'Surowy typ zdarzenia') },
    { key: 'state', type: 'string', role: 'text', name: N('Event state', 'Stan zdarzenia') },
    { key: 'target', type: 'string', role: 'text', name: N('Target (human/vehicle/other)', 'Cel (człowiek/pojazd/inny)') },
    { key: 'timestamp', type: 'string', role: 'date', name: N('Camera timestamp', 'Czas z kamery') },
    { key: 'receivedAt', type: 'string', role: 'date', name: N('Received at', 'Odebrano o') },
    { key: 'channel', type: 'number', role: 'value', name: N('Channel', 'Kanał') },
    { key: 'ruleId', type: 'string', role: 'text', name: N('Rule ID', 'ID reguły') },
    { key: 'regionId', type: 'string', role: 'text', name: N('Region ID', 'ID obszaru') },
    { key: 'direction', type: 'string', role: 'text', name: N('Direction', 'Kierunek') },
    { key: 'sequence', type: 'number', role: 'value', name: N('Event sequence number', 'Numer kolejny zdarzenia') },
    { key: 'json', type: 'string', role: 'json', name: N('Event as JSON', 'Zdarzenie jako JSON') },
];
const MAX_PENDING_WRITES = 5000;
const THROTTLE_MS = 30_000;
/** Everything that belongs to one camera: connection, alarm state, ioBroker objects. */
class CameraRuntime {
    cfg;
    io;
    log;
    runtimeOpts;
    id;
    root;
    client;
    manager;
    states;
    ensured = new Set();
    countBase = new Map();
    rawNames = new Map();
    chain = Promise.resolve();
    pending = 0;
    droppedWrites = 0;
    eventsReceived = 0;
    parseErrors = 0;
    reconnects = 0;
    sequence = 0;
    connected = false;
    lastHeartbeatWrite = 0;
    rawCaptured = 0;
    lastLoggedReason = '';
    constructor(cfg, io, log, runtimeOpts = {}) {
        this.cfg = cfg;
        this.io = io;
        this.log = log;
        this.runtimeOpts = runtimeOpts;
        this.id = cfg.id;
        this.root = `cameras.${cfg.id}`;
        this.client = new CameraClient_1.CameraClient({
            host: cfg.host,
            port: cfg.port,
            https: cfg.https,
            username: cfg.username,
            password: cfg.password,
            authMode: cfg.authMode,
            verifyTls: cfg.verifyTls,
            connectTimeoutMs: 15_000,
            streamIdleTimeoutMs: cfg.streamTimeoutMs,
        });
        this.states = new EventStateManager_1.EventStateManager({
            cameraId: cfg.id,
            timeoutMs: cfg.alarmTimeoutMs,
            onChange: change => this.enqueue(() => this.publishChange(change)),
            onEvent: (ev, outcome) => this.onProcessed(ev, outcome),
        });
        this.manager = new ConnectionManager_1.ConnectionManager({
            cameraId: cfg.id,
            opener: runtimeOpts.opener ?? this.client,
            retry: new RetryPolicy_1.RetryPolicy(cfg.reconnectIntervalMs, 5 * 60_000),
            authRetryMs: 30 * 60_000,
            maxAuthFailures: 3,
            slowRetryMs: 5 * 60_000,
            discoverUnknown: cfg.discoverUnknown,
            capture: cfg.diagnostic,
            callbacks: {
                onState: (state, detail) => this.onState(state, detail),
                onConnected: () => this.onConnected(),
                onLive: () => this.enqueue(() => this.io.setState(`${this.root}.info.streamConnected`, true)),
                onDisconnected: (reason, kind) => this.onDisconnected(reason, kind),
                onReconnectScheduled: delay => this.onReconnectScheduled(delay),
                onEvent: ev => this.onEvent(ev),
                onParseError: msg => this.onParseError(msg),
                onRaw: text => this.onRaw(text),
            },
        });
    }
    isConnected() {
        return this.connected;
    }
    async init() {
        await this.ensure('cameras', { type: 'folder', common: { name: N('Cameras', 'Kamery') }, native: {} });
        await this.ensure(this.root, {
            type: 'device',
            common: { name: this.cfg.name },
            native: { host: this.cfg.host },
        });
        await this.ensure(`${this.root}.info`, { type: 'channel', common: { name: N('Information', 'Informacje') }, native: {} });
        await this.ensure(`${this.root}.events`, { type: 'folder', common: { name: N('Events', 'Zdarzenia') }, native: {} });
        await this.ensure(`${this.root}.lastEvent`, { type: 'channel', common: { name: N('Last event', 'Ostatnie zdarzenie') }, native: {} });
        for (const def of INFO_STATES) {
            await this.ensureState(`${this.root}.info.${def.key}`, def);
        }
        if (this.cfg.diagnostic) {
            await this.ensureState(`${this.root}.info.lastRawPayload`, {
                key: 'lastRawPayload',
                type: 'string',
                role: 'text',
                name: N('Last raw payload (diagnostic, redacted)', 'Ostatnie surowe dane (diagnostyka, zanonimizowane)'),
            });
        }
        for (const def of LAST_EVENT_STATES) {
            await this.ensureState(`${this.root}.lastEvent.${def.key}`, def);
        }
        this.eventsReceived = (await this.io.getNumber(`${this.root}.info.eventsReceived`)) ?? 0;
        this.parseErrors = (await this.io.getNumber(`${this.root}.info.parseErrors`)) ?? 0;
        this.reconnects = (await this.io.getNumber(`${this.root}.info.reconnectCount`)) ?? 0;
        this.sequence = (await this.io.getNumber(`${this.root}.lastEvent.sequence`)) ?? 0;
        await this.io.setState(`${this.root}.info.connection`, false);
        await this.io.setState(`${this.root}.info.streamConnected`, false);
        await this.io.setState(`${this.root}.info.status`, 'idle');
        await this.io.setState(`${this.root}.info.ipAddress`, this.cfg.host);
        await this.markStoredEventsUnknown();
    }
    start() {
        this.log.debug(`[${this.id}] starting stream to ${this.cfg.https ? 'https' : 'http'}://${this.cfg.host}:${this.cfg.port}`);
        this.manager.start();
    }
    async stop() {
        this.manager.stop();
        // Shutting down is not "no alarm": leave every alarm unknown for whoever reads the states next.
        this.states.setConnected(false);
        this.states.dispose();
        await Promise.race([this.chain, new Promise(resolve => setTimeout(resolve, 2000).unref?.())]);
        try {
            await this.io.setState(`${this.root}.info.connection`, false);
            await this.io.setState(`${this.root}.info.streamConnected`, false);
        }
        catch {
            // adapter is shutting down
        }
    }
    // ---- connection callbacks -------------------------------------------------
    onState(state, detail) {
        const text = state === 'authFailed' || state === 'denied' || state === 'unsupported' || state === 'lost' ? `${state}: ${detail}` : state;
        this.enqueue(() => this.io.setState(`${this.root}.info.status`, text));
    }
    onConnected() {
        this.connected = true;
        this.lastLoggedReason = '';
        this.states.setConnected(true);
        const now = new Date().toISOString();
        this.enqueue(async () => {
            await this.io.setState(`${this.root}.info.connection`, true);
            await this.io.setState(`${this.root}.info.streamConnected`, false);
            await this.io.setState(`${this.root}.info.lastSuccessfulConnection`, now);
        });
        this.log.info(`[${this.id}] connected to ${this.cfg.host}`);
        this.runtimeOpts.onConnectionChange?.();
        void this.fetchDeviceInfo();
    }
    onDisconnected(reason, kind) {
        const wasConnected = this.connected;
        this.connected = false;
        // Disconnected is NOT "no alarm": every alarm becomes unknown until the stream is back.
        this.states.setConnected(false);
        const message = (0, util_1.redact)(reason, [this.cfg.password]);
        this.enqueue(async () => {
            await this.io.setState(`${this.root}.info.connection`, false);
            await this.io.setState(`${this.root}.info.streamConnected`, false);
            await this.io.setState(`${this.root}.info.lastError`, message);
        });
        if (wasConnected || message !== this.lastLoggedReason) {
            const level = kind === 'auth' || kind === 'forbidden' || kind === 'unsupported' ? 'error' : 'warn';
            this.log[level](`[${this.id}] ${message}`);
            this.lastLoggedReason = message;
        }
        else {
            this.log.debug(`[${this.id}] ${message}`);
        }
        this.runtimeOpts.onConnectionChange?.();
    }
    onReconnectScheduled(delayMs) {
        this.reconnects++;
        const count = this.reconnects;
        this.enqueue(() => this.io.setState(`${this.root}.info.reconnectCount`, count));
        this.log.debug(`[${this.id}] reconnecting in ${Math.round(delayMs / 1000)} s`);
    }
    onParseError(msg) {
        this.parseErrors++;
        const n = this.parseErrors;
        this.enqueue(() => this.io.setState(`${this.root}.info.parseErrors`, n));
        if (n <= 3 || n % 100 === 0) {
            this.log.warn(`[${this.id}] unparseable event data (${n} so far): ${(0, util_1.redact)(msg, [this.cfg.password])}`);
        }
        else {
            this.log.debug(`[${this.id}] unparseable event data: ${msg}`);
        }
    }
    onRaw(text) {
        const clean = (0, util_1.redact)(text, [this.cfg.password, this.cfg.username]);
        this.enqueue(() => this.io.setState(`${this.root}.info.lastRawPayload`, clean));
        if (this.rawCaptured >= 50) {
            return;
        }
        this.rawCaptured++;
        this.log.info(`[${this.id}] raw payload #${this.rawCaptured}: ${clean}`);
    }
    // ---- events ---------------------------------------------------------------
    onEvent(ev) {
        const now = Date.now();
        if (ev.heartbeat) {
            if (now - this.lastHeartbeatWrite >= THROTTLE_MS) {
                this.lastHeartbeatWrite = now;
                const iso = ev.receivedAt;
                this.enqueue(async () => {
                    await this.io.setState(`${this.root}.info.lastHeartbeat`, iso);
                    await this.io.setState(`${this.root}.info.lastSeen`, iso);
                });
            }
        }
        else {
            if (this.cfg.eventFilter.has(ev.eventType) || this.cfg.eventFilter.has(ev.rawEventType.toLowerCase())) {
                return;
            }
            this.eventsReceived++;
            const count = this.eventsReceived;
            this.rawNames.set(ev.eventType, ev.rawEventType);
            this.enqueue(async () => {
                await this.io.setState(`${this.root}.info.eventsReceived`, count);
                await this.io.setState(`${this.root}.info.lastSeen`, ev.receivedAt);
            });
        }
        this.states.handle(ev);
    }
    onProcessed(ev, outcome) {
        if (outcome !== 'trigger' && outcome !== 'clear') {
            return;
        }
        const seq = outcome === 'trigger' ? ++this.sequence : this.sequence;
        this.enqueue(() => this.writeLastEvent(ev, seq));
    }
    async writeLastEvent(ev, seq) {
        const p = `${this.root}.lastEvent`;
        const set = (k, v, force = false) => this.io.setState(`${p}.${k}`, v, { force });
        await set('type', ev.eventType);
        await set('rawType', ev.rawEventType);
        await set('state', ev.eventState);
        await set('target', ev.target);
        await set('timestamp', ev.timestamp ?? ev.cameraTimestamp ?? '');
        await set('receivedAt', ev.receivedAt, true);
        await set('channel', ev.channelId);
        await set('ruleId', ev.ruleId ?? '');
        await set('regionId', ev.regionId ?? '');
        await set('direction', ev.direction ?? '');
        await set('sequence', seq, true);
        await set('json', JSON.stringify({ ...ev, sequence: seq }), true);
        await this.io.setState(`${this.root}.info.lastEvent`, ev.receivedAt, { force: true });
    }
    // ---- object / state publishing ---------------------------------------------
    async publishChange(c) {
        const base = `${this.root}.events.${c.eventType}`;
        const a = c.aggregate;
        await this.ensureEventObjects(c.eventType, a.targetSeen);
        const baseline = this.countBase.get(base) ?? 0;
        const set = (id, v, force = false) => this.io.setState(id, v, { force });
        await set(`${base}.active`, a.active);
        await set(`${base}.state`, a.state);
        await set(`${base}.valid`, a.valid);
        await set(`${base}.count`, baseline + a.count);
        if (a.lastTriggered) {
            await set(`${base}.lastTriggered`, a.lastTriggered, true);
        }
        await set(`${base}.lastTarget`, a.lastTarget);
        if (a.targetSeen) {
            await set(`${base}.human.active`, a.human);
            await set(`${base}.vehicle.active`, a.vehicle);
        }
        if (c.slot.detail) {
            const slotBase = `${base}.rules.${c.slot.key}`;
            await this.ensureSlotObjects(slotBase, c);
            const slotBaseline = this.countBase.get(slotBase) ?? 0;
            await set(`${slotBase}.active`, c.slot.state === 'unknown' ? null : c.slot.state === 'active');
            await set(`${slotBase}.state`, c.slot.state);
            await set(`${slotBase}.count`, slotBaseline + c.slot.count);
            if (c.slot.lastTriggered) {
                await set(`${slotBase}.lastTriggered`, c.slot.lastTriggered, true);
            }
            await set(`${slotBase}.target`, c.slot.target);
        }
    }
    async ensureEventObjects(eventType, targets) {
        const base = `${this.root}.events.${eventType}`;
        const raw = this.rawNames.get(eventType);
        const label = EVENT_LABELS[eventType] ?? N(`Event: ${raw ?? eventType}`, `Zdarzenie: ${raw ?? eventType}`);
        if (!this.ensured.has(base)) {
            await this.ensure(base, { type: 'channel', common: { name: label }, native: { rawEventType: raw ?? null } });
            this.countBase.set(base, (await this.io.getNumber(`${base}.count`)) ?? 0);
        }
        const defs = [
            { key: 'active', type: 'boolean', role: 'sensor.alarm', name: N('Active', 'Aktywne') },
            { key: 'state', type: 'string', role: 'text', name: N('State (active/inactive/unknown)', 'Stan (aktywne/nieaktywne/nieznane)') },
            { key: 'valid', type: 'boolean', role: 'indicator', name: N('State is reliable (stream connected)', 'Stan wiarygodny (strumień połączony)') },
            { key: 'lastTriggered', type: 'string', role: 'date', name: N('Last triggered', 'Ostatnie wyzwolenie') },
            { key: 'count', type: 'number', role: 'value', name: N('Trigger count', 'Liczba wyzwoleń') },
            { key: 'lastTarget', type: 'string', role: 'text', name: N('Last target', 'Ostatni cel') },
        ];
        for (const def of defs) {
            await this.ensureState(`${base}.${def.key}`, def);
        }
        if (targets) {
            await this.ensure(`${base}.human`, { type: 'channel', common: { name: N('Human', 'Człowiek') }, native: {} });
            await this.ensure(`${base}.vehicle`, { type: 'channel', common: { name: N('Vehicle', 'Pojazd') }, native: {} });
            await this.ensureState(`${base}.human.active`, { key: 'active', type: 'boolean', role: 'sensor.alarm', name: N('Human detected', 'Wykryto człowieka') });
            await this.ensureState(`${base}.vehicle.active`, { key: 'active', type: 'boolean', role: 'sensor.alarm', name: N('Vehicle detected', 'Wykryto pojazd') });
        }
    }
    async ensureSlotObjects(slotBase, c) {
        if (!this.ensured.has(slotBase)) {
            const parts = [`ch${c.slot.channelId}`];
            if (c.slot.ruleId !== undefined) {
                parts.push(`rule ${c.slot.ruleId}`);
            }
            if (c.slot.regionId !== undefined) {
                parts.push(`region ${c.slot.regionId}`);
            }
            await this.ensure(`${this.root}.events.${c.eventType}.rules`, { type: 'folder', common: { name: N('Rules', 'Reguły') }, native: {} });
            await this.ensure(slotBase, {
                type: 'channel',
                common: { name: parts.join(', ') },
                native: { channelId: c.slot.channelId, ruleId: c.slot.ruleId ?? null, regionId: c.slot.regionId ?? null },
            });
            this.countBase.set(slotBase, (await this.io.getNumber(`${slotBase}.count`)) ?? 0);
        }
        const defs = [
            { key: 'active', type: 'boolean', role: 'sensor.alarm', name: N('Active', 'Aktywne') },
            { key: 'state', type: 'string', role: 'text', name: N('State', 'Stan') },
            { key: 'count', type: 'number', role: 'value', name: N('Trigger count', 'Liczba wyzwoleń') },
            { key: 'lastTriggered', type: 'string', role: 'date', name: N('Last triggered', 'Ostatnie wyzwolenie') },
            { key: 'target', type: 'string', role: 'text', name: N('Target', 'Cel') },
        ];
        for (const def of defs) {
            await this.ensureState(`${slotBase}.${def.key}`, def);
        }
    }
    /**
     * After an adapter restart, states from the previous run must not look
     * like a trustworthy "no alarm" / "alarm": mark them unknown until the
     * stream is connected again.
     */
    async markStoredEventsUnknown() {
        let ids;
        try {
            ids = await this.io.listStates(`${this.root}.events.`);
        }
        catch (err) {
            this.log.debug(`[${this.id}] could not list stored events: ${(0, util_1.describeError)(err)}`);
            return;
        }
        for (const id of ids) {
            const rel = id.slice(`${this.root}.events.`.length);
            if (/(^|\.)(active|human\.active|vehicle\.active)$/.test(rel)) {
                await this.io.setState(id, null);
            }
            else if (/(^|\.)state$/.test(rel)) {
                await this.io.setState(id, 'unknown');
            }
            else if (/^[^.]+\.valid$/.test(rel)) {
                await this.io.setState(id, false);
            }
        }
    }
    async fetchDeviceInfo() {
        try {
            const xml = await (this.runtimeOpts.fetchText ?? ((p) => this.client.getText(p)))(CameraClient_1.DEVICE_INFO_PATH);
            const fields = new Map();
            (0, xml_1.flattenXml)((0, xml_1.parseXml)(xml), fields);
            const model = fields.get('model');
            const fw = fields.get('firmwareversion');
            if (model) {
                this.enqueue(() => this.io.setState(`${this.root}.info.model`, model));
            }
            if (fw) {
                this.enqueue(() => this.io.setState(`${this.root}.info.firmware`, fw));
            }
        }
        catch (err) {
            this.log.debug(`[${this.id}] device info not available: ${(0, util_1.describeError)(err)}`);
        }
    }
    // ---- helpers ----------------------------------------------------------------
    async ensure(id, obj) {
        if (!this.ensured.has(id)) {
            await this.io.extendObject(id, obj);
            this.ensured.add(id);
        }
    }
    async ensureState(id, def) {
        await this.ensure(id, {
            type: 'state',
            common: { name: def.name, type: def.type, role: def.role, read: true, write: false },
            native: {},
        });
    }
    /** Serialize ioBroker writes per camera; bounded so a stalled DB cannot grow memory forever. */
    enqueue(work) {
        if (this.pending >= MAX_PENDING_WRITES) {
            if (this.droppedWrites++ === 0) {
                this.log.warn(`[${this.id}] too many pending state writes; dropping updates until the backlog clears`);
            }
            return;
        }
        this.pending++;
        this.chain = this.chain
            .then(work)
            .catch(err => this.log.debug(`[${this.id}] state write failed: ${(0, util_1.describeError)(err)}`))
            .finally(() => {
            this.pending--;
        });
    }
}
exports.CameraRuntime = CameraRuntime;
