# Operational Runbook: Production Purchase Index Migration & Write-Pause Coordination

**Target Database:** `billing_inventory`  
**Target Collection:** `purchases`  
**Target Index:** `tenantId_1_operationId_1`  
**Old Filter:** `{ operationId: { $exists: true } }` (Live Atlas)  
**Intended Target Filter:** `{ operationId: { $type: "string", $gt: "" } }` (Source Model)  
**Document Status:** Production Operational Runbook  

---

## 1. Scope, Authority & Critical Invariants

### 1.1 Authorization
- **Maintenance Authority:** Only authorized Database Administrators (DBA) and Lead Platform Engineers may initiate the maintenance freeze, execute database DDL, or lift the maintenance pause.
- **Explicit Approval Required:** The live migration script `scripts/migrate-purchase-indexes-production.ts --apply` **MUST NEVER** be executed without prior written authorization from the Technical Lead / Change Management Board.

### 1.2 Storage Engine Constraint (Why Write-Pause is Required)
MongoDB storage engines (WiredTiger) do **not** allow two indexes sharing the identical key specification (`{ tenantId: 1, operationId: 1 }`) but differing in `partialFilterExpression` options to coexist simultaneously. Attempting to create the new index while the old index exists will fail immediately with `IndexOptionsConflict` (error code 85).

Consequently:
1. The old index must be dropped before the new partial index is created.
2. During the interval between `dropIndex` and `createIndex`, the collection `purchases` is temporarily **UNINDEXED** on `{ tenantId: 1, operationId: 1 }`.
3. To prevent duplicate non-empty `operationId` records from being inserted during this unindexed window, all incoming purchase mutations and sync processing must be paused at the application layer across all serving instances before any DDL is executed.

---

## 2. Infrastructure & Deployment Platform Context

### 2.1 Repository Platform Limitations
Inspection of the codebase confirms that the project consists of a Next.js / Node.js application using Mongoose. The repository does not include infrastructure-as-code files (such as Kubernetes manifests, AWS ECS task definitions, Dockerfiles, or `vercel.json`).

Therefore, this runbook provides:
1. **Platform-agnostic verification requirements** that must be fulfilled regardless of the hosting provider.
2. **Specific example command sequences** for common Node.js production hosting architectures (Container Orchestrators like ECS/Kubernetes, Process Managers like PM2/systemd, and PaaS/Serverless like Vercel).

Operators must apply the deployment commands matching the active production infrastructure.

---

## 3. Pre-Migration Prerequisites & Safety Checklist

Before initiating the maintenance window, verify:
- [ ] Database backup / Atlas continuous snapshot is healthy and verified within the last 1 hour.
- [ ] Direct access to MongoDB primary replica set node via `mongosh` is established.
- [ ] Administrative privileges on MongoDB (`billing_inventory` database owner role) confirmed.
- [ ] Local dependencies installed and verified: `npx tsx scripts/test-migrate-purchase-indexes-production.ts` passes 70/70 checks.
- [ ] Local write-pause tests verified: `npx tsx scripts/test-server-write-pause.ts` passes 70/70 checks.

---

## 4. Phase 1: Enabling the Server-Side Write Pause

### 4.1 Update Deployment Configuration
Set the following environment variable across **all** application instances, background workers, and API nodes:
```bash
PURCHASE_WRITES_PAUSED="true"
```

### 4.2 Execute Rolling Restart / Deployment
Because Node.js evaluates `process.env` in-memory from process startup, changing the environment variable requires recycling all running instances.

- **For Kubernetes / Container Clusters:**
  ```bash
  # Example: Trigger rolling rollout to inject new env
  kubectl rollout restart deployment/billing-app -n production
  kubectl rollout status deployment/billing-app -n production
  ```
- **For AWS ECS:**
  ```bash
  # Example: Force new deployment with updated task definition
  aws ecs update-service --cluster production --service billing-saas --force-new-deployment
  ```
- **For PM2 / systemd Node.js Servers:**
  ```bash
  # Example: Reload processes with updated environment
  pm2 reload all --update-env
  ```
- **For PaaS / Vercel:**
  Promote environment variable `PURCHASE_WRITES_PAUSED="true"` to Production and trigger a redeployment.

---

## 5. Phase 2: Proving Writer Fencing & Complete Write Draining

> [!CRITICAL]
> A fixed 60-second delay or querying `SyncOperation.countDocuments({ status: "PENDING" })` **DOES NOT PROVE** that writes have drained.
> Operators must gather positive evidence across all three tiers: Deployment, Ingress, and Database.

### 5.1 Deployment Evidence: 100% Instance Recycling
Verify that zero instances running the old configuration remain alive:
1. Confirm container orchestrator or process manager reports that 100% of active tasks/pods have a start time / age newer than the rollout initiation timestamp.
2. Confirm all terminating/draining tasks have finished and exited.

### 5.2 Ingress & Application Response Verification
Issue probe requests against the production API endpoints to verify that write-pause is active:
1. **Direct Purchase Creation Probe:**
   ```bash
   curl -X POST "https://<app-domain>/api/purchases" \
     -H "Content-Type: application/json" \
     -H "Cookie: <authorized-session-cookie>" \
     -d '{"purchaseNo":"PROBE-TEST","supplierId":"<valid-id>","warehouse":{"name":"Main"},"items":[]}'
   ```
   **Expected Response:** HTTP `503 Service Unavailable`, `Retry-After: 30`, and body:
   ```json
   {
     "success": false,
     "code": "MAINTENANCE_PAUSED",
     "retryable": true,
     "retryAfterSeconds": 30
   }
   ```
2. **Purchase Sync Upload Probe:**
   ```bash
   curl -X POST "https://<app-domain>/api/sync-operations" \
     -H "Content-Type: application/json" \
     -H "Cookie: <authorized-session-cookie>" \
     -d '{"operationId":"PROBE-OP-1","operationType":"CREATE","entityType":"Purchase","payload":{}}'
   ```
   **Expected Response:** HTTP `503 Service Unavailable` with `code: "MAINTENANCE_PAUSED"`.
3. **Non-Purchase Isolation Verification:**
   Verify that a non-purchase operation (e.g. Sale sync upload or Customer read) is **not** blocked by the purchase maintenance switch.

### 5.3 Database Lease Evidence: Zero In-Flight Sync Leases
In `mongosh` connected to the primary replica node, verify that zero sync workers hold active processing leases on purchases:
```javascript
use billing_inventory;

const activeLeases = db.syncoperations.countDocuments({
  entityType: "Purchase",
  status: "PROCESSING"
});

print("Active Purchase processing leases: " + activeLeases);
```
**Required Result:** `Active Purchase processing leases: 0`.

If `activeLeases > 0`, wait until the lease expiry (`SYNC_LEASE_MS`, up to 2 minutes) or until in-flight workers finish.

### 5.4 Database Activity Evidence: Zero In-Flight Transactions & Operations
Inspect active database operations on the MongoDB primary node:
```javascript
use billing_inventory;

// 1. Check for active writes on purchases or syncoperations
const activeOps = db.currentOp({
  "ns": /^billing_inventory\.(purchases|syncoperations)/,
  "active": true,
  "op": { $in: ["insert", "update", "delete", "command"] }
});

print("Active target collection operations: " + activeOps.inprog.length);

// 2. Check for open multi-document transactions touching the database
const activeTxns = db.getSiblingDB("admin").aggregate([
  { $currentOp: { allUsers: true, idleSessions: false } },
  { $match: { "transaction.timeOpenMicros": { $exists: true } } }
]).toArray();

print("Active open transactions: " + activeTxns.length);
```
**Required Result:**
- `Active target collection operations: 0`
- `Active open transactions: 0`

---

## 6. Phase 3: Dry-Run Verification

Once Phase 2 evidence confirms all writers are fenced and drained:

1. Execute the migration script in default **DRY-RUN** mode on an authorized bastion/operator host:
   ```bash
   CONFIRM_PRODUCTION_INDEX_MIGRATION=billing_inventory \
   MONGODB_URI="<atlas-connection-string>" \
   npx tsx scripts/migrate-purchase-indexes-production.ts --dry-run
   ```
2. Verify the output:
   - `[STAGE 1]` PASS: Guards verified.
   - `[STAGE 2]` Purchase OperationId Index status: `[OLD_EXISTS_PARTIAL]`.
   - `[STAGE 3]` Document Audit Breakdown: Confirm 0 duplicates, 0 conflicting non-empty IDs.
   - `[STAGE 4]` Planned Action: `REPLACE`.
   - Output ends with `[DRY RUN COMPLETE] Zero modifications made to MongoDB indexes or documents.` and exit code `0`.

---

## 7. Phase 4: Explicit Authorization & Live Apply Execution

### 7.1 Approval Checkpoint
Obtain final verbal or ticket confirmation from the Lead DBA / Incident Commander before proceeding.

### 7.2 Live Apply Invocation
Execute the migration with the explicit `--apply` flag:
```bash
CONFIRM_PRODUCTION_INDEX_MIGRATION=billing_inventory \
MONGODB_URI="<atlas-connection-string>" \
npx tsx scripts/migrate-purchase-indexes-production.ts --apply
```

### 7.3 Expected Execution Output
```text
=== SAFE PRODUCTION PURCHASE INDEX MIGRATION (billing_inventory) ===
>>> MODE: LIVE APPLY (Controlled DDL execution on production Atlas) <<<

[STAGE 1] Checking production guards...
PASS: Guards verified (target database: billing_inventory).

PASS: Connected to active database 'billing_inventory'.

[STAGE 2] Inspecting purchase index catalog...
  - Purchase OperationId Index status: [OLD_EXISTS_PARTIAL] ...

[STAGE 3] Auditing purchase documents and checking for conflicting operationIds...
PASS: No duplicate nonempty operationIds found.

[STAGE 4] Performing controlled index migration...
  - Dropping old index 'tenantId_1_operationId_1'...
  - Creating unique partial index 'tenantId_1_operationId_1'...
  - Unique partial index 'tenantId_1_operationId_1' created successfully.

[STAGE 5] Verifying final index catalog definition...
PASS: Index 'tenantId_1_operationId_1' verified in catalog with exact expected keys, unique: true, and partialFilterExpression.

============================================================
PRODUCTION PURCHASE INDEX MIGRATION COMPLETED SUCCESSFULLY.
============================================================
```

---

## 8. Phase 5: Post-Migration Verification & Write Resumption

### 8.1 MongoDB Index Catalog Verification
Verify the index catalog directly via `mongosh`:
```javascript
use billing_inventory;

const idx = db.purchases.getIndexes().find(i => i.name === "tenantId_1_operationId_1");
printjson(idx);
```
**Required Verification:**
```javascript
{
  "v": 2,
  "key": { "tenantId": 1, "operationId": 1 },
  "name": "tenantId_1_operationId_1",
  "unique": true,
  "partialFilterExpression": {
    "operationId": { "$type": "string", "$gt": "" }
  }
}
```

### 8.2 Lift the Server-Side Write Pause
1. Remove `PURCHASE_WRITES_PAUSED` or set `PURCHASE_WRITES_PAUSED="false"` in the deployment configuration.
2. Execute a rolling restart across all application instances.
3. Verify instances now return `200` / `201` for purchase operations.

### 8.3 Verify Offline Client Queue Drain
1. Monitor connected offline clients / devices.
2. Verify that queued purchases in IndexedDB (which were safely waiting with status `FAILED` and scheduled backoff) resume syncing automatically upon their next scheduled attempt.
3. Confirm in `SyncOperation` that the operations transition to `status: "SYNCED"`.

---

## 9. Failure Modes & Emergency Remediation

| Failure Point | System State | Immediate Action |
| :--- | :--- | :--- |
| **Old index drop fails** | The old index remains intact in Atlas. Replacement creation was **NOT** attempted. | Abort migration. The collection remains fully indexed with the old filter. Resolve MongoDB permissions/locks before re-attempting. |
| **Replacement creation fails post-drop** | The old index was dropped. The collection is temporarily **UNINDEXED** on `{ tenantId: 1, operationId: 1 }`. | **DO NOT RESTORE THE OLD INDEX**. Keep `PURCHASE_WRITES_PAUSED="true"` active. Run the manual recovery command in `mongosh` (see Section 9.1). |
| **Un-restarted instances detected** | Old instance accepting writes during maintenance. | Immediately terminate the old instance. Check `db.currentOp()`. Run pre-replacement duplicate audit before proceeding. |

### 9.1 Emergency Manual Remediation Command
If index creation failed post-drop, connect to `mongosh` on the primary and create the intended index manually:
```javascript
use billing_inventory;

db.purchases.createIndex(
  { tenantId: 1, operationId: 1 },
  {
    name: "tenantId_1_operationId_1",
    unique: true,
    partialFilterExpression: { operationId: { $type: "string", $gt: "" } }
  }
);
```
Verify with `db.purchases.getIndexes()`. Only lift the write pause after the index is verified.
