
/*
 * Shared permission records for tests.
 *
 * Permission names live in one shared catalogue (not per tenant). A test
 * that needs a permission which does not exist yet creates it with an _id
 * registered BEFORE the insert (run.newSharedPermissionId), so cleanup can
 * remove exactly the records this run created. Existing records are only
 * read, never modified or deleted.
 */

import type { Types } from "mongoose";

import type { TestRun } from "./testRunSafety";

interface PermissionModel {
    findOne(filter: { name: string }): { select(fields: string): { lean(): Promise<unknown> } };
    create(doc: { _id: Types.ObjectId; name: string; description: string }): Promise<unknown>;
}

/** Returns name -> _id for every requested permission, creating missing ones. */
export async function ensureTestPermissions(
    run: TestRun,
    Permission: PermissionModel,
    names: string[]
): Promise<Map<string, Types.ObjectId>> {
    const ids = new Map<string, Types.ObjectId>();

    for (const name of names) {
        const existing = (await Permission.findOne({ name }).select("_id").lean()) as { _id: Types.ObjectId } | null;
        if (existing) {
            ids.set(name, existing._id);
            continue;
        }

        const id = run.newSharedPermissionId(name);
        try {
            await Permission.create({ _id: id, name, description: `TEST-CREATED (${run.runId})` });
            ids.set(name, id);
        } catch (error) {
            // Created by someone else in the meantime (unique name): use theirs.
            if ((error as { code?: unknown })?.code !== 11000) throw error;
            const now = (await Permission.findOne({ name }).select("_id").lean()) as { _id: Types.ObjectId } | null;
            if (!now) throw error;
            ids.set(name, now._id);
        }
    }

    return ids;
}
