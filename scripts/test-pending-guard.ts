
/*
 * Pending-queue guard and export tests (NO DATABASE, NO BROWSER, NO NETWORK).
 *
 * Exercises lib/offline/pendingGuard.ts with plain in-memory items.
 *
 * Run:
 *   npx tsx scripts/test-pending-guard.ts
 */

import {
    EXPORT_FORMAT,
    assertQueueItemDeletable,
    buildPendingExport,
    canonicalJson,
    decideAccountSwitch,
    isAcknowledgementIntact,
    verifyPendingExport,
    type ExportAcknowledgement,
    type GuardItem,
    type PendingExport,
} from "../lib/offline/pendingGuard";
import type { SessionIdentity } from "../lib/offline/syncPolicy";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const id = (n: number) => n.toString(16).padStart(24, "0");
const alice: SessionIdentity = { tenantId: id(1), userId: id(2), deviceId: id(3) };
const bob: SessionIdentity = { tenantId: id(1), userId: id(4), deviceId: id(5) };
const aliceOtherDevice: SessionIdentity = { ...alice, deviceId: id(6) };
const aliceOtherTenant: SessionIdentity = { ...alice, tenantId: id(7) };
const NOW = Date.UTC(2026, 9, 12, 9, 0, 0);

let seq = 0;
function item(status: string, owner: SessionIdentity | undefined, extra: Partial<GuardItem> = {}): GuardItem {
    seq += 1;
    return {
        operationId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
        operationType: "CREATE",
        entityType: "Sale",
        payload: { invoiceNo: `INV-${seq}`, items: [{ productId: id(100 + seq), quantity: 1 }] },
        status,
        localSeq: 1000 + seq,
        attempts: 0,
        createdAt: new Date(NOW + seq * 1000).toISOString(),
        owner,
        ...extra,
    };
}

async function main() {
    // ------------------------------------------------------------ switching
    const items: GuardItem[] = [
        item("PENDING", alice),
        item("FAILED", alice, { attempts: 2, errorMessage: "temporary" }),
        item("SYNCING", alice),
        item("NEEDS_ATTENTION", alice, { errorMessage: "permanent" }),
        item("SYNCED", alice),
        item("PENDING", alice, { entityType: "Purchase" }),
        item("PENDING", alice, { entityType: "StockAdjustment" }),
    ];

    const blockedBob = await decideAccountSwitch(items, bob, null);
    check("W1. A different account is blocked while any unsynced item exists",
        !blockedBob.allowed && blockedBob.blockingCount === 6 && blockedBob.uncoveredCount === 6, JSON.stringify(blockedBob));
    check("W2. Every unsynced status counts, including SYNCING and NEEDS_ATTENTION; SYNCED does not",
        !blockedBob.allowed
        && blockedBob.byStatus.PENDING === 3 && blockedBob.byStatus.FAILED === 1
        && blockedBob.byStatus.SYNCING === 1 && blockedBob.byStatus.NEEDS_ATTENTION === 1
        && blockedBob.byStatus.SYNCED === undefined, JSON.stringify(blockedBob));
    check("W3. Every entity type blocks (Sale, Purchase, StockAdjustment)",
        (await decideAccountSwitch([item("PENDING", alice, { entityType: "StockAdjustment" })], bob, null)).allowed === false
        && (await decideAccountSwitch([item("PENDING", alice, { entityType: "Payment" })], bob, null)).allowed === false);

    const sameOwner = await decideAccountSwitch(items, alice, null);
    check("W4. The same owner (tenant + user + device) may sign in again", sameOwner.allowed && !sameOwner.viaExport);

    const onlySynced = await decideAccountSwitch([item("SYNCED", alice), item("SYNCED", bob)], bob, null);
    check("W5. Only SYNCED items never block", onlySynced.allowed);
    check("W6. An empty queue never blocks", (await decideAccountSwitch([], bob, null)).allowed);

    check("W7. The same user on another device is a different owner: blocked",
        !(await decideAccountSwitch(items, aliceOtherDevice, null)).allowed);
    check("W8. The same user ID under another tenant is a different owner: blocked",
        !(await decideAccountSwitch(items, aliceOtherTenant, null)).allowed);

    const legacy = item("NEEDS_ATTENTION", undefined, { legacyUnowned: true });
    const legacyDecision = await decideAccountSwitch([legacy], alice, null);
    check("W9. Items from before account tracking (no owner) also block everyone until exported",
        !legacyDecision.allowed && legacyDecision.unownedCount === 1, JSON.stringify(legacyDecision));

    check("W10. The block message data carries counts only, never owner identifiers",
        !JSON.stringify(blockedBob).includes(alice.userId) && !JSON.stringify(blockedBob).includes(alice.tenantId));

    // ------------------------------------------------------------ export content
    const before = JSON.stringify(items);
    const { file, acknowledgement } = await buildPendingExport([...items, item("PENDING", bob)], NOW);
    check("X1. The export covers every unsynced item of every owner (7 of 8: SYNCED excluded)", file.itemCount === 7 && file.items.length === 7);
    check("X2. The export has the expected format and no SYNCED item",
        file.format === EXPORT_FORMAT && file.items.every((x) => x.status !== "SYNCED"));
    check("X3. Ownership, status, type, payload and errors are preserved per item",
        items.filter((x) => x.status !== "SYNCED").every((x) => {
            const e = file.items.find((y) => y.operationId === x.operationId);
            return Boolean(e) && JSON.stringify(e!.owner) === JSON.stringify(x.owner) && e!.status === x.status
                && e!.entityType === x.entityType && e!.errorMessage === (x.errorMessage ?? null)
                && canonicalJson(e!.payload) === canonicalJson(x.payload) && e!.attempts === x.attempts
                && e!.localSeq === x.localSeq && e!.createdAt === x.createdAt;
        }));
    check("X4. The unowned legacy item is exported with owner null and legacyUnowned true",
        (await buildPendingExport([legacy], NOW)).file.items[0].owner === null
        && (await buildPendingExport([legacy], NOW)).file.items[0].legacyUnowned === true);
    check("X5. Items are in queue order", file.items.every((x, i) => i === 0 || file.items[i - 1].localSeq <= x.localSeq));
    check("X6. Building an export never changes the queue items", JSON.stringify(items) === before);
    {
        const copy = structuredClone(items);
        const { file: f } = await buildPendingExport(copy, NOW);
        (f.items[0].payload as Record<string, unknown>).invoiceNo = "CHANGED";
        f.items[0].status = "SYNCED";
        check("X7. The export is a copy: editing it does not change the queue items", JSON.stringify(copy) === before);
    }
    check("X8. The export states it is not an import and that no import endpoint exists",
        /NOT imported/.test(file.note) && /no import endpoint/i.test(file.note));

    // ------------------------------------------------------------ export integrity
    check("Y1. A fresh export verifies", await verifyPendingExport(file));
    const edit = (change: (f: PendingExport) => void) => { const f = structuredClone(file); change(f); return f; };
    check("Y2. A changed payload fails verification", !(await verifyPendingExport(edit((f) => { (f.items[0].payload as Record<string, unknown>).invoiceNo = "X"; }))));
    check("Y3. A changed status fails verification", !(await verifyPendingExport(edit((f) => { f.items[0].status = "SYNCED"; }))));
    check("Y4. A changed owner fails verification", !(await verifyPendingExport(edit((f) => { f.items[0].owner = bob; }))));
    check("Y5. A removed item fails verification", !(await verifyPendingExport(edit((f) => { f.items.pop(); f.itemCount = f.items.length; }))));
    check("Y6. A wrong item count fails verification", !(await verifyPendingExport(edit((f) => { f.itemCount += 1; }))));
    check("Y7. A wrong digest or format fails verification",
        !(await verifyPendingExport(edit((f) => { f.digest = "0".repeat(64); })))
        && !(await verifyPendingExport(edit((f) => { (f as { format: string }).format = "other"; }))));
    check("Y8. The digest does not depend on object key order",
        canonicalJson({ a: 1, b: { c: 2, d: 3 } }) === canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
    check("Y9. The acknowledgement of a fresh export is intact", await isAcknowledgementIntact(acknowledgement));

    // ------------------------------------------------------------ switching with an export
    const aliceOnly = items;
    const ackAlice = (await buildPendingExport(aliceOnly, NOW)).acknowledgement;

    const viaExport = await decideAccountSwitch(aliceOnly, bob, ackAlice);
    check("Z1. After a verified export covering every item, a different account may sign in (items stay put)",
        viaExport.allowed && viaExport.viaExport && viaExport.unsyncedForOthers === 6, JSON.stringify(viaExport));
    check("Z2. ...and the queue was not changed by the decision", JSON.stringify(aliceOnly) === before);

    const withNew = [...aliceOnly, item("PENDING", alice)];
    const newer = await decideAccountSwitch(withNew, bob, ackAlice);
    check("Z3. An item queued after the export is not covered: still blocked",
        !newer.allowed && newer.uncoveredCount === 1 && newer.blockingCount === 7, JSON.stringify(newer));

    const changedPayload = structuredClone(aliceOnly);
    (changedPayload[0].payload as Record<string, unknown>).invoiceNo = "TAMPERED";
    const tamperedItem = await decideAccountSwitch(changedPayload, bob, ackAlice);
    check("Z4. An item whose content changed after the export is not covered: blocked",
        !tamperedItem.allowed && tamperedItem.uncoveredCount === 1, JSON.stringify(tamperedItem));

    const changedOwner = structuredClone(aliceOnly);
    changedOwner[0].owner = bob;
    const reassigned = await decideAccountSwitch(changedOwner, aliceOtherDevice, ackAlice);
    check("Z5. An item whose owner changed after the export is not covered", !reassigned.allowed);

    const statusMoved = structuredClone(aliceOnly);
    statusMoved[0].status = "FAILED";
    statusMoved[0].attempts = 3;
    statusMoved[0].errorMessage = "retry later";
    check("Z6. Normal sync bookkeeping (status, attempts, error text) does not invalidate the export",
        (await decideAccountSwitch(statusMoved, bob, ackAlice)).allowed);

    const damagedAck: ExportAcknowledgement = structuredClone(ackAlice);
    damagedAck.manifest[Object.keys(damagedAck.manifest)[0]] = "f".repeat(64);
    check("Z7. A damaged acknowledgement is ignored: blocked",
        !(await isAcknowledgementIntact(damagedAck)) && !(await decideAccountSwitch(aliceOnly, bob, damagedAck)).allowed);
    const forged: ExportAcknowledgement = { exportedAt: "x", exportDigest: "y", manifest: {}, manifestDigest: "z" };
    check("Z8. A made-up acknowledgement is ignored: blocked", !(await decideAccountSwitch(aliceOnly, bob, forged)).allowed);

    const partialAck = (await buildPendingExport(aliceOnly.slice(0, 2), NOW)).acknowledgement;
    const partial = await decideAccountSwitch(aliceOnly, bob, partialAck);
    check("Z9. An export covering only some items does not unblock the rest",
        !partial.allowed && partial.uncoveredCount === 4 && partial.blockingCount === 6, JSON.stringify(partial));

    check("Z10. The same owner is never affected by an export", (await decideAccountSwitch(aliceOnly, alice, ackAlice)).allowed);

    // ------------------------------------------------------------ deletion
    const attempt = (queued: GuardItem | undefined, who: SessionIdentity | null) => {
        try { assertQueueItemDeletable(queued, who); return true; } catch { return false; }
    };
    check("R1. A SYNCED item owned by the current account can be deleted", attempt(item("SYNCED", alice), alice));
    for (const status of ["PENDING", "SYNCING", "FAILED", "NEEDS_ATTENTION"]) {
        check(`R2. A ${status} item cannot be deleted, even by its owner`, !attempt(item(status, alice), alice));
    }
    check("R3. A SYNCED item of another account cannot be deleted", !attempt(item("SYNCED", alice), bob));
    check("R4. A SYNCED item on another device of the same user cannot be deleted", !attempt(item("SYNCED", alice), aliceOtherDevice));
    check("R5. A SYNCED item with no owner cannot be deleted", !attempt(item("SYNCED", undefined), alice));
    check("R6. Nothing can be deleted without a signed-in account or for a missing item",
        !attempt(item("SYNCED", alice), null) && !attempt(undefined, alice));

    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    process.exitCode = failed.length ? 1 : 0;
}

main().catch((error: unknown) => {
    console.error("Pending guard tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
