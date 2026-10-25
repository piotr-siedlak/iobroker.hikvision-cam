import { CameraClient, DEVICE_INFO_PATH } from './CameraClient';
import type { StreamOpener } from './CameraClient';
import { ConnectionManager } from './ConnectionManager';
import type { ConnState } from './ConnectionManager';
import type { NormalizedCameraConfig } from './config';
import { EventStateManager } from './EventStateManager';
import type { EventOutcome, StateChange } from './EventStateManager';
import type { IoApi, LogApi, StateVal } from './io';
import { RetryPolicy } from './RetryPolicy';
import type { HikvisionEvent } from './types';
import { describeError, redact } from './util';
import { flattenXml, parseXml } from './xml';

type Names = { en: string; pl: string };
const N = (en: string, pl: string): Names => ({ en, pl });

const EVENT_LABELS: Record<string, Names> = {
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

interface StateDef {
    key: string;
    type: 'boolean' | 'string' | 'number';
    role: string;
    name: Names;
}

const INFO_STATES: StateDef[] = [
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

const LAST_EVENT_STATES: StateDef[] = [
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

export interface RuntimeOptions {
    onConnectionChange?: () => void;
    /** Test hook / future NVR support: custom stream source. */
    opener?: StreamOpener;
}

/** Everything that belongs to one camera: connection, alarm state, ioBroker objects. */
export class CameraRuntime {
    readonly id: string;
    private readonly root: string;
    private readonly client: CameraClient;
    private readonly manager: ConnectionManager;
    private readonly states: EventStateManager;
    private readonly ensured = new Set<string>();
    private readonly countBase = new Map<string, number>();
    private readonly rawNames = new Map<string, string>();
    private chain: Promise<void> = Promise.resolve();
    private pending = 0;
    private droppedWrites = 0;
    private eventsReceived = 0;
    private parseErrors = 0;
    private reconnects = 0;
    private sequence = 0;
    private connected = false;
    private lastHeartbeatWrite = 0;
    private rawCaptured = 0;
    private lastLoggedReason = '';

    constructor(
        private readonly cfg: NormalizedCameraConfig,
        private readonly io: IoApi,
        private readonly log: LogApi,
        private readonly runtimeOpts: RuntimeOptions = {},
    ) {
        this.id = cfg.id;
        this.root = `cameras.${cfg.id}`;
        this.client = new CameraClient({
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

        this.states = new EventStateManager({
            cameraId: cfg.id,
            timeoutMs: cfg.alarmTimeoutMs,
            onChange: change => this.enqueue(() => this.publishChange(change)),
            onEvent: (ev, outcome) => this.onProcessed(ev, outcome),
        });

        this.manager = new ConnectionManager({
            cameraId: cfg.id,
            opener: runtimeOpts.opener ?? this.client,
            retry: new RetryPolicy(cfg.reconnectIntervalMs, 5 * 60_000),
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

    isConnected(): boolean {
        return this.connected;
    }

    async init(): Promise<void> {
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

    start(): void {
        this.log.debug(`[${this.id}] starting stream to ${this.cfg.https ? 'https' : 'http'}://${this.cfg.host}:${this.cfg.port}`);
        this.manager.start();
    }

    async stop(): Promise<void> {
        this.manager.stop();
        this.states.dispose();
        await Promise.race([this.chain, new Promise<void>(resolve => setTimeout(resolve, 2000).unref?.())]);
        try {
            await this.io.setState(`${this.root}.info.connection`, false);
            await this.io.setState(`${this.root}.info.streamConnected`, false);
        } catch {
            // adapter is shutting down
        }
    }

    // ---- connection callbacks -------------------------------------------------

    private onState(state: ConnState, detail: string): void {
        const text = state === 'authFailed' || state === 'denied' || state === 'unsupported' || state === 'lost' ? `${state}: ${detail}` : state;
        this.enqueue(() => this.io.setState(`${this.root}.info.status`, text));
    }

    private onConnected(): void {
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

    private onDisconnected(reason: string, kind: string): void {
        const wasConnected = this.connected;
        this.connected = false;
        // Disconnected is NOT "no alarm": every alarm becomes unknown until the stream is back.
        this.states.setConnected(false);
        const message = redact(reason, [this.cfg.password]);
        this.enqueue(async () => {
            await this.io.setState(`${this.root}.info.connection`, false);
            await this.io.setState(`${this.root}.info.streamConnected`, false);
            await this.io.setState(`${this.root}.info.lastError`, message);
        });
        if (wasConnected || message !== this.lastLoggedReason) {
            const level = kind === 'auth' || kind === 'forbidden' || kind === 'unsupported' ? 'error' : 'warn';
            this.log[level](`[${this.id}] ${message}`);
            this.lastLoggedReason = message;
        } else {
            this.log.debug(`[${this.id}] ${message}`);
        }
        this.runtimeOpts.onConnectionChange?.();
    }

    private onReconnectScheduled(delayMs: number): void {
        this.reconnects++;
        const count = this.reconnects;
        this.enqueue(() => this.io.setState(`${this.root}.info.reconnectCount`, count));
        this.log.debug(`[${this.id}] reconnecting in ${Math.round(delayMs / 1000)} s`);
    }

    private onParseError(msg: string): void {
        this.parseErrors++;
        const n = this.parseErrors;
        this.enqueue(() => this.io.setState(`${this.root}.info.parseErrors`, n));
        if (n <= 3 || n % 100 === 0) {
            this.log.warn(`[${this.id}] unparseable event data (${n} so far): ${redact(msg, [this.cfg.password])}`);
        } else {
            this.log.debug(`[${this.id}] unparseable event data: ${msg}`);
        }
    }

    private onRaw(text: string): void {
        if (this.rawCaptured >= 50) {
            return;
        }
        this.rawCaptured++;
        this.log.info(`[${this.id}] raw payload #${this.rawCaptured}: ${redact(text, [this.cfg.password, this.cfg.username])}`);
    }

    // ---- events ---------------------------------------------------------------

    private onEvent(ev: HikvisionEvent): void {
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
        } else {
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

    private onProcessed(ev: HikvisionEvent, outcome: EventOutcome): void {
        if (outcome !== 'trigger' && outcome !== 'clear') {
            return;
        }
        const seq = outcome === 'trigger' ? ++this.sequence : this.sequence;
        this.enqueue(() => this.writeLastEvent(ev, seq));
    }

    private async writeLastEvent(ev: HikvisionEvent, seq: number): Promise<void> {
        const p = `${this.root}.lastEvent`;
        const set = (k: string, v: StateVal, force = false): Promise<void> => this.io.setState(`${p}.${k}`, v, { force });
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

    private async publishChange(c: StateChange): Promise<void> {
        const base = `${this.root}.events.${c.eventType}`;
        const a = c.aggregate;
        await this.ensureEventObjects(c.eventType, a.targetSeen);
        const baseline = this.countBase.get(base) ?? 0;

        const set = (id: string, v: StateVal, force = false): Promise<void> => this.io.setState(id, v, { force });
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

    private async ensureEventObjects(eventType: string, targets: boolean): Promise<void> {
        const base = `${this.root}.events.${eventType}`;
        const raw = this.rawNames.get(eventType);
        const label = EVENT_LABELS[eventType] ?? N(`Event: ${raw ?? eventType}`, `Zdarzenie: ${raw ?? eventType}`);
        if (!this.ensured.has(base)) {
            await this.ensure(base, { type: 'channel', common: { name: label }, native: { rawEventType: raw ?? null } });
            this.countBase.set(base, (await this.io.getNumber(`${base}.count`)) ?? 0);
        }
        const defs: StateDef[] = [
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

    private async ensureSlotObjects(slotBase: string, c: StateChange): Promise<void> {
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
        const defs: StateDef[] = [
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
    private async markStoredEventsUnknown(): Promise<void> {
        let ids: string[];
        try {
            ids = await this.io.listStates(`${this.root}.events.`);
        } catch (err) {
            this.log.debug(`[${this.id}] could not list stored events: ${describeError(err)}`);
            return;
        }
        for (const id of ids) {
            const rel = id.slice(`${this.root}.events.`.length);
            if (/(^|\.)(active|human\.active|vehicle\.active)$/.test(rel)) {
                await this.io.setState(id, null);
            } else if (/(^|\.)state$/.test(rel)) {
                await this.io.setState(id, 'unknown');
            } else if (/^[^.]+\.valid$/.test(rel)) {
                await this.io.setState(id, false);
            }
        }
    }

    private async fetchDeviceInfo(): Promise<void> {
        try {
            const xml = await this.client.getText(DEVICE_INFO_PATH);
            const fields = new Map<string, string>();
            flattenXml(parseXml(xml), fields);
            const model = fields.get('model');
            const fw = fields.get('firmwareversion');
            if (model) {
                this.enqueue(() => this.io.setState(`${this.root}.info.model`, model));
            }
            if (fw) {
                this.enqueue(() => this.io.setState(`${this.root}.info.firmware`, fw));
            }
        } catch (err) {
            this.log.debug(`[${this.id}] device info not available: ${describeError(err)}`);
        }
    }

    // ---- helpers ----------------------------------------------------------------

    private async ensure(id: string, obj: Record<string, unknown>): Promise<void> {
        if (!this.ensured.has(id)) {
            await this.io.extendObject(id, obj);
            this.ensured.add(id);
        }
    }

    private async ensureState(id: string, def: StateDef): Promise<void> {
        await this.ensure(id, {
            type: 'state',
            common: { name: def.name, type: def.type, role: def.role, read: true, write: false },
            native: {},
        });
    }

    /** Serialize ioBroker writes per camera; bounded so a stalled DB cannot grow memory forever. */
    private enqueue(work: () => Promise<void>): void {
        if (this.pending >= MAX_PENDING_WRITES) {
            if (this.droppedWrites++ === 0) {
                this.log.warn(`[${this.id}] too many pending state writes; dropping updates until the backlog clears`);
            }
            return;
        }
        this.pending++;
        this.chain = this.chain
            .then(work)
            .catch(err => this.log.debug(`[${this.id}] state write failed: ${describeError(err)}`))
            .finally(() => {
                this.pending--;
            });
    }
}
