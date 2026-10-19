
import { offlineDB } from "./db";
import {
    buildPendingExport,
    decideAccountSwitch,
    unsyncedItems,
    verifyPendingExport,
    type ExportAcknowledgement,
    type PendingExport,
    type SwitchDecision,
} from "./pendingGuard";
import type { SessionIdentity } from "./syncPolicy";

/*
 * Browser side of the pending-queue protection (see pendingGuard.ts).
 * Everything here only READS the queue. The only thing written is the small
 * export acknowledgement in the meta table; queue items are never changed,
 * deleted or reassigned.
 */

export const EXPORT_ACK_KEY = "pendingExportAck";

async function readAcknowledgement(): Promise<ExportAcknowledgement | null> {
    const value = (await offlineDB.meta.get(EXPORT_ACK_KEY))?.value;
    return value && typeof value === "object" ? (value as ExportAcknowledgement) : null;
}

/** Number of unsynced queue items of ALL accounts on this device. */
export async function countAllUnsyncedItems(): Promise<number> {
    if (typeof indexedDB === "undefined") return 0;
    return unsyncedItems(await offlineDB.syncQueue.toArray()).length;
}

/**
 * May this (server-confirmed) account sign in on this device? Where
 * IndexedDB does not exist there is no queue to protect. Any other failure
 * throws, and callers must then refuse the switch (fail closed).
 */
export async function checkAccountSwitch(candidate: SessionIdentity): Promise<SwitchDecision> {
    if (typeof indexedDB === "undefined") return { allowed: true, viaExport: false, unsyncedForOthers: 0 };
    const items = await offlineDB.syncQueue.toArray();
    return decideAccountSwitch(items, candidate, await readAcknowledgement());
}

export interface CreatedExport {
    file: PendingExport;
    json: string;
    filename: string;
    acknowledgement: ExportAcknowledgement;
}

/**
 * Build the verified export of every unsynced item and check its digest.
 * Throws if the export does not verify. Nothing is remembered yet: the
 * caller saves the file first and then calls rememberExport. Queue items
 * are not touched.
 */
export async function createPendingExport(): Promise<CreatedExport> {
    const items = await offlineDB.syncQueue.toArray();
    const { file, acknowledgement } = await buildPendingExport(items, Date.now());

    if (!(await verifyPendingExport(file))) {
        throw new Error("The export could not be verified and was not saved");
    }

    return {
        file,
        json: JSON.stringify(file, null, 2),
        filename: `pending-sales-${file.exportedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`,
        acknowledgement,
    };
}

/** Remember that this export was handed to the user (lifts the switch block for exactly these items). */
export async function rememberExport(created: CreatedExport): Promise<void> {
    await offlineDB.meta.put({ key: EXPORT_ACK_KEY, value: created.acknowledgement });
}
