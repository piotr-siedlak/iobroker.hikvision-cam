export type StateVal = string | number | boolean | null;

/** Minimal adapter surface used by the camera runtime (ids are relative to the adapter namespace). */
export interface IoApi {
    extendObject(id: string, obj: Record<string, unknown>): Promise<void>;
    /** Writes with ack=true. Unchanged values are skipped unless `force` is set. */
    setState(id: string, val: StateVal, opts?: { force?: boolean }): Promise<void>;
    getNumber(id: string): Promise<number | undefined>;
    getString(id: string): Promise<string | undefined>;
    /** Stores a file in the adapter's file storage; returns its storage path. */
    writeFile(name: string, data: Buffer): Promise<string>;
    /** Relative ids of all state objects below `prefix`. */
    listStates(prefix: string): Promise<string[]>;
}

export interface LogApi {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}
