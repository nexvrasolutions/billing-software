
import {
    SalesService,
    type CreateSaleInput,
    type SalePolicy,
} from "@/lib/services/SalesService";

import {
    BUSINESS_PERMISSIONS,
    SALE_DATE_RULES,
    getGrantedBusinessPermissions,
    getSyncEntityPermission,
} from "@/lib/auth/businessPermissions";

import {
    PurchaseService,
    type CreatePurchaseInput,
} from "@/lib/services/PurchaseService";

import {
    SalesReturnService,
    type CreateSalesReturnInput,
} from "@/lib/services/SalesReturnService";

import {
    PurchaseReturnService,
    type CreatePurchaseReturnInput,
} from "@/lib/services/PurchaseReturnService";

import {
    PaymentService,
    type CreatePaymentInput,
} from "@/lib/services/PaymentService";

import { StockService } from "./StockService";
import { ProductSyncService } from "./ProductSyncService";
import { CustomerSyncService } from "./CustomerSyncService";
import { Device } from "../models/Device";
import { Sale } from "../models/Sale";
import mongoose from "mongoose";
import { SyncOperation } from "../models/SyncOperation";
import { randomUUID } from "crypto";
import {
    MAX_SYNC_ATTEMPTS,
    SYNC_LEASE_MS,
    SyncProcessError,
    classifySyncError,
    publicStoredSyncMessage,
    publicSyncErrorMessage,
    statusAfterFailure,
} from "./SyncErrors";

// ============================================================
// TYPES
// ============================================================

export interface SyncUserContext {
    tenantId: mongoose.Types.ObjectId;
    // Identity of the authenticated session processing the operation.
    userId: mongoose.Types.ObjectId;
    deviceId: mongoose.Types.ObjectId;
    // The session user's CURRENT role (from the database, not the token).
    roleId?: string;
}

// ============================================================
// PAYLOAD VALIDATION HELPERS
// ============================================================

function getPayloadObject(
    value: unknown
): Record<string, unknown> {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value)
    ) {
        throw new Error("Sync payload must be an object");
    }

    return value as Record<string, unknown>;
}

function requiredString(
    value: unknown,
    field: string
): string {
    if (
        typeof value !== "string" ||
        !value.trim()
    ) {
        throw new Error(
            `Invalid or missing field: ${field}`
        );
    }

    return value.trim();
}

function optionalString(
    value: unknown,
    field: string
): string | undefined {
    if (
        value === undefined ||
        value === null
    ) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw new Error(
            `Invalid field: ${field}`
        );
    }

    return value;
}

function requiredNumber(
    value: unknown,
    field: string
): number {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value)
    ) {
        throw new Error(
            `Invalid or missing number: ${field}`
        );
    }

    return value;
}

function optionalNumber(
    value: unknown,
    field: string
): number | undefined {
    if (
        value === undefined ||
        value === null
    ) {
        return undefined;
    }

    return requiredNumber(value, field);
}

function optionalDate(
    value: unknown,
    field: string
): Date | undefined {
    if (
        value === undefined ||
        value === null ||
        value === ""
    ) {
        return undefined;
    }

    if (
        typeof value !== "string" &&
        !(value instanceof Date)
    ) {
        throw new Error(
            `Invalid date: ${field}`
        );
    }

    const date = new Date(value);

    if (!Number.isFinite(date.getTime())) {
        throw new Error(
            `Invalid date: ${field}`
        );
    }

    return date;
}

function requiredWarehouse(
    value: unknown
): {
    name: string;
    location?: string;
} {
    const warehouse = getPayloadObject(value);

    return {
        name: requiredString(
            warehouse.name,
            "warehouse.name"
        ),
        location: optionalString(
            warehouse.location,
            "warehouse.location"
        ),
    };
}

function requiredItems<T>(
    value: unknown,
    parser: (
        item: unknown,
        index: number
    ) => T
): T[] {
    if (
        !Array.isArray(value) ||
        value.length === 0
    ) {
        throw new Error(
            "At least one item is required"
        );
    }

    return value.map(parser);
}

// ============================================================
// SALE PAYLOAD
// ============================================================

export function parseSalePayload(
    value: unknown
): CreateSaleInput {
    const p = getPayloadObject(value);

    const allowedPaymentMethods = [
        "cash",
        "bank",
        "upi",
        "card",
        "credit",
    ] as const;

    if (
        p.paymentMethod !== undefined &&
        !allowedPaymentMethods.includes(
            p.paymentMethod as
            (typeof allowedPaymentMethods)[number]
        )
    ) {
        throw new Error(
            "Invalid sale payment method"
        );
    }

    const rawInvoiceNo = optionalString(p.invoiceNo, "invoiceNo");
    const rawProvisionalNo = optionalString(p.provisionalInvoiceNo, "provisionalInvoiceNo");
    const effectiveInvoiceNo = rawInvoiceNo || rawProvisionalNo;
    if (!effectiveInvoiceNo) {
        throw new Error("Invalid or missing field: invoiceNo or provisionalInvoiceNo");
    }

    return {
        invoiceNo: effectiveInvoiceNo,

        provisionalInvoiceNo: rawProvisionalNo,

        customerId: optionalString(
            p.customerId,
            "customerId"
        ),

        saleDate: optionalDate(
            p.saleDate,
            "saleDate"
        ),

        warehouse: requiredWarehouse(
            p.warehouse
        ),

        items: requiredItems(
            p.items,
            (value, index) => {
                const item =
                    getPayloadObject(value);

                return {
                    productId: requiredString(
                        item.productId,
                        `items[${index}].productId`
                    ),

                    quantity: requiredNumber(
                        item.quantity,
                        `items[${index}].quantity`
                    ),

                    unitPrice: optionalNumber(
                        item.unitPrice,
                        `items[${index}].unitPrice`
                    ),

                    discountRate: optionalNumber(
                        item.discountRate,
                        `items[${index}].discountRate`
                    ),

                    discountAmount: optionalNumber(
                        item.discountAmount,
                        `items[${index}].discountAmount`
                    ),

                    taxRate: optionalNumber(
                        item.taxRate,
                        `items[${index}].taxRate`
                    ),
                };
            }
        ),

        paidAmount: optionalNumber(
            p.paidAmount,
            "paidAmount"
        ),

        paymentMethod:
            p.paymentMethod as
            CreateSaleInput["paymentMethod"],

        paymentComponents: Array.isArray(p.paymentComponents)
            ? p.paymentComponents.map((c, i) => {
                const comp = getPayloadObject(c);
                const method = requiredString(comp.method, `paymentComponents[${i}].method`);
                if (!["cash", "bank", "upi", "card"].includes(method)) {
                    throw new Error(`Invalid payment component method: ${method}`);
                }
                const amount = requiredNumber(comp.amount, `paymentComponents[${i}].amount`);
                if (amount <= 0) {
                    throw new Error(`Payment component amount must be greater than zero`);
                }
                return {
                    method: method as "cash" | "bank" | "upi" | "card",
                    amount,
                    referenceNo: optionalString(comp.referenceNo, `paymentComponents[${i}].referenceNo`),
                    notes: optionalString(comp.notes, `paymentComponents[${i}].notes`),
                };
            })
            : undefined,

        roundOff: typeof p.roundOff === "boolean" ? p.roundOff : undefined,

        notes: optionalString(
            p.notes,
            "notes"
        ),
    };
}

// ============================================================
// PURCHASE PAYLOAD
// ============================================================

function parsePurchasePayload(
    value: unknown
): CreatePurchaseInput {
    const p = getPayloadObject(value);

    const allowedPaymentStatuses = [
        "unpaid",
        "partial",
        "paid",
    ] as const;

    if (
        p.paymentStatus !== undefined &&
        !allowedPaymentStatuses.includes(
            p.paymentStatus as
            (typeof allowedPaymentStatuses)[number]
        )
    ) {
        throw new Error(
            "Invalid purchase payment status"
        );
    }

    return {
        purchaseNo: requiredString(
            p.purchaseNo,
            "purchaseNo"
        ),

        supplierId: requiredString(
            p.supplierId,
            "supplierId"
        ),

        purchaseDate: optionalDate(
            p.purchaseDate,
            "purchaseDate"
        ),

        supplierInvoiceNo: optionalString(
            p.supplierInvoiceNo,
            "supplierInvoiceNo"
        ),

        supplierInvoiceDate: optionalDate(
            p.supplierInvoiceDate,
            "supplierInvoiceDate"
        ),

        dueDate: optionalDate(
            p.dueDate,
            "dueDate"
        ),

        warehouse: requiredWarehouse(
            p.warehouse
        ),

        items: requiredItems(
            p.items,
            (value, index) => {
                const item =
                    getPayloadObject(value);

                return {
                    productId: requiredString(
                        item.productId,
                        `items[${index}].productId`
                    ),

                    quantity: requiredNumber(
                        item.quantity,
                        `items[${index}].quantity`
                    ),

                    unitPrice: requiredNumber(
                        item.unitPrice,
                        `items[${index}].unitPrice`
                    ),

                    discountRate: optionalNumber(
                        item.discountRate,
                        `items[${index}].discountRate`
                    ),

                    taxRate: optionalNumber(
                        item.taxRate,
                        `items[${index}].taxRate`
                    ),
                };
            }
        ),

        shippingCost: optionalNumber(
            p.shippingCost,
            "shippingCost"
        ),

        paidAmount: optionalNumber(
            p.paidAmount,
            "paidAmount"
        ),

        paymentStatus:
            p.paymentStatus as
            CreatePurchaseInput["paymentStatus"],

        notes: optionalString(
            p.notes,
            "notes"
        ),
    };
}

// ============================================================
// SALES RETURN PAYLOAD
// ============================================================

function parseSalesReturnPayload(
    value: unknown
): CreateSalesReturnInput {
    const p = getPayloadObject(value);

    const allowedRefundStatuses = [
        "pending",
        "refunded",
        "not_applicable",
    ] as const;

    if (
        p.refundStatus !== undefined &&
        !allowedRefundStatuses.includes(
            p.refundStatus as
            (typeof allowedRefundStatuses)[number]
        )
    ) {
        throw new Error(
            "Invalid sales return refund status"
        );
    }

    return {
        salesReturnNo: requiredString(
            p.salesReturnNo,
            "salesReturnNo"
        ),

        saleId: requiredString(
            p.saleId,
            "saleId"
        ),

        customerId: optionalString(
            p.customerId,
            "customerId"
        ),

        returnDate: optionalDate(
            p.returnDate,
            "returnDate"
        ),

        warehouse: requiredWarehouse(
            p.warehouse
        ),

        items: requiredItems(
            p.items,
            (value, index) => {
                const item =
                    getPayloadObject(value);

                return {
                    productId: requiredString(
                        item.productId,
                        `items[${index}].productId`
                    ),

                    quantity: requiredNumber(
                        item.quantity,
                        `items[${index}].quantity`
                    ),
                };
            }
        ),

        refundAmount: optionalNumber(
            p.refundAmount,
            "refundAmount"
        ),

        refundStatus:
            p.refundStatus as
            CreateSalesReturnInput["refundStatus"],

        reason: optionalString(
            p.reason,
            "reason"
        ),

        notes: optionalString(
            p.notes,
            "notes"
        ),
    };
}

// ============================================================
// PURCHASE RETURN PAYLOAD
// ============================================================

function parsePurchaseReturnPayload(
    value: unknown
): CreatePurchaseReturnInput {
    const p = getPayloadObject(value);

    const allowedRefundStatuses = [
        "pending",
        "refunded",
        "not_applicable",
    ] as const;

    if (
        p.refundStatus !== undefined &&
        !allowedRefundStatuses.includes(
            p.refundStatus as
            (typeof allowedRefundStatuses)[number]
        )
    ) {
        throw new Error(
            "Invalid purchase return refund status"
        );
    }

    return {
        purchaseReturnNo: requiredString(
            p.purchaseReturnNo,
            "purchaseReturnNo"
        ),

        purchaseId: requiredString(
            p.purchaseId,
            "purchaseId"
        ),

        returnDate: optionalDate(
            p.returnDate,
            "returnDate"
        ),

        warehouse: requiredWarehouse(
            p.warehouse
        ),

        items: requiredItems(
            p.items,
            (value, index) => {
                const item =
                    getPayloadObject(value);

                return {
                    productId: requiredString(
                        item.productId,
                        `items[${index}].productId`
                    ),

                    quantity: requiredNumber(
                        item.quantity,
                        `items[${index}].quantity`
                    ),
                };
            }
        ),

        refundAmount: optionalNumber(
            p.refundAmount,
            "refundAmount"
        ),

        refundStatus:
            p.refundStatus as
            CreatePurchaseReturnInput["refundStatus"],

        reason: optionalString(
            p.reason,
            "reason"
        ),

        notes: optionalString(
            p.notes,
            "notes"
        ),
    };
}

// ============================================================
// PAYMENT PAYLOAD
// ============================================================

function parsePaymentPayload(
    value: unknown
): CreatePaymentInput {
    const p = getPayloadObject(value);

    const allowedTypes = [
        "receipt",
        "payment",
        "sales_refund",
        "purchase_refund",
    ] as const;

    const allowedMethods = [
        "cash",
        "upi",
        "card",
        "bank",
        "credit",
        "other",
    ] as const;

    const allowedStatuses = [
        "pending",
        "completed",
        "failed",
        "cancelled",
    ] as const;

    if (
        !allowedTypes.includes(
            p.type as
            (typeof allowedTypes)[number]
        )
    ) {
        throw new Error(
            "Invalid payment type"
        );
    }

    if (
        !allowedMethods.includes(
            p.paymentMethod as
            (typeof allowedMethods)[number]
        )
    ) {
        throw new Error(
            "Invalid payment method"
        );
    }

    if (
        p.status !== undefined &&
        !allowedStatuses.includes(
            p.status as
            (typeof allowedStatuses)[number]
        )
    ) {
        throw new Error(
            "Invalid payment status"
        );
    }

    return {
        paymentNo: requiredString(
            p.paymentNo,
            "paymentNo"
        ),

        type: p.type as
            CreatePaymentInput["type"],

        amount: requiredNumber(
            p.amount,
            "amount"
        ),

        paymentMethod: p.paymentMethod as
            CreatePaymentInput["paymentMethod"],

        paymentDate: optionalDate(
            p.paymentDate,
            "paymentDate"
        ),

        customerId: optionalString(
            p.customerId,
            "customerId"
        ),

        supplierId: optionalString(
            p.supplierId,
            "supplierId"
        ),

        saleId: optionalString(
            p.saleId,
            "saleId"
        ),

        purchaseId: optionalString(
            p.purchaseId,
            "purchaseId"
        ),

        salesReturnId: optionalString(
            p.salesReturnId,
            "salesReturnId"
        ),

        purchaseReturnId: optionalString(
            p.purchaseReturnId,
            "purchaseReturnId"
        ),

        referenceNo: optionalString(
            p.referenceNo,
            "referenceNo"
        ),

        notes: optionalString(
            p.notes,
            "notes"
        ),

        status: p.status as
            CreatePaymentInput["status"],
    };
}

// ============================================================
// STOCK ADJUSTMENT PAYLOAD
// ============================================================

function parseStockAdjustmentPayload(
    value: unknown
): {
    productId: string;
    quantity: number;
    warehouse: {
        name: string;
        location?: string;
    };
    reason: string;
} {
    const p = getPayloadObject(value);

    return {
        productId: requiredString(
            p.productId,
            "productId"
        ),

        quantity: requiredNumber(
            p.quantity,
            "quantity"
        ),

        warehouse: requiredWarehouse(
            p.warehouse
        ),

        reason: requiredString(
            p.reason,
            "reason"
        ),
    };
}

// ============================================================
// SYNC SERVICE
// ============================================================

export class SyncService {
    /**
     * Process one uploaded operation for the CURRENT session.
     *
     * Safety rules:
     * - Only the uploading user on the uploading device may process it.
     * - Claims are atomic and leased: a crashed worker's claim expires and
     *   can be reclaimed. Every business operation below is idempotent per
     *   operationId, so re-running a reclaimed operation never duplicates
     *   sales, stock movements or payments.
     * - Temporary failures may be retried (bounded); permanent business
     *   failures go to NEEDS_ATTENTION and are never retried automatically.
     */
    static async processOperation(
        user: SyncUserContext,
        operationId: string
    ) {
        const normalizedOperationId = operationId?.trim();

        if (!user.tenantId || !user.userId || !user.deviceId) {
            throw new SyncProcessError(401, "INVALID_REQUEST", "Session context is required", false);
        }

        if (!normalizedOperationId) {
            throw new SyncProcessError(400, "INVALID_REQUEST", "Operation ID is required", false);
        }

        // 1. Find the operation inside the caller's tenant only.
        const existingOperation = await SyncOperation.findOne({
            tenantId: user.tenantId,
            operationId: normalizedOperationId,
        });

        if (!existingOperation) {
            throw new SyncProcessError(404, "NOT_FOUND", "Sync operation not found", true);
        }

        // 2. Only the uploading user on the uploading device may process it.
        //    Legacy records have no userId: then the session's device must
        //    be the operation's device (checked below against its owner).
        if (
            !existingOperation.deviceId.equals(user.deviceId) ||
            (existingOperation.userId && !existingOperation.userId.equals(user.userId))
        ) {
            throw new SyncProcessError(
                403,
                "OWNER_MISMATCH",
                "This operation belongs to another user or device",
                false
            );
        }

        // 3. Terminal states.
        if (existingOperation.status === "SYNCED") {
            return { success: true, alreadySynced: true, operation: existingOperation };
        }

        if (existingOperation.status === "NEEDS_ATTENTION" || existingOperation.status === "CANCELLED") {
            throw new SyncProcessError(
                422,
                "NEEDS_ATTENTION",
                // Stored text may predate sanitizing: never return it raw.
                existingOperation.errorMessage
                    ? `Operation needs attention: ${publicStoredSyncMessage(existingOperation.errorMessage)}`
                    : "Operation needs attention and will not be retried automatically",
                false
            );
        }

        // 4. Too many attempts already: stop retrying.
        if (existingOperation.status === "FAILED" && existingOperation.attempts >= MAX_SYNC_ATTEMPTS) {
            await SyncOperation.updateOne(
                { _id: existingOperation._id, tenantId: user.tenantId, status: "FAILED" },
                { $set: { status: "NEEDS_ATTENTION", failureKind: "RETRIES_EXHAUSTED" } }
            );
            throw new SyncProcessError(
                422,
                "NEEDS_ATTENTION",
                "Operation failed too many times and needs attention",
                false
            );
        }

        // 4b. Deny by default: an operation type without an explicit
        //     permission mapping is rejected BEFORE it is claimed, so no
        //     business code runs for it. It is flagged for review (status
        //     only; ownership was verified in step 2).
        const mappedPermission = getSyncEntityPermission(existingOperation.entityType);

        if (!mappedPermission) {
            const message = "This type of operation cannot be synchronized; it needs review";

            await SyncOperation.updateOne(
                {
                    _id: existingOperation._id,
                    tenantId: user.tenantId,
                    status: { $in: ["PENDING", "FAILED"] },
                },
                { $set: { status: "NEEDS_ATTENTION", failureKind: "PERMANENT", errorMessage: message } }
            );

            throw new SyncProcessError(403, "PERMISSION_DENIED", message, false);
        }

        // 5. Claim atomically with a lease. Claimable: PENDING, FAILED, or a
        //    PROCESSING claim whose lease expired (crashed/stalled worker).
        //    Legacy PROCESSING records without a lease are reclaimable once
        //    their last attempt is older than the lease duration.
        //    The ownership rules of step 2 are part of the claim itself, so a
        //    record whose owner changed after step 2 is never claimed: the
        //    session's device, and the session's user (or no user at all on a
        //    legacy record; that device's owner is checked in step 6).
        const now = new Date();
        const leaseToken = randomUUID();
        const operation = await SyncOperation.findOneAndUpdate(
            {
                _id: existingOperation._id,
                tenantId: user.tenantId,
                deviceId: user.deviceId,
                attempts: { $lt: MAX_SYNC_ATTEMPTS },
                $and: [
                    // userId: null matches a missing or null userId (legacy).
                    { $or: [{ userId: user.userId }, { userId: null }] },
                    {
                        $or: [
                            { status: { $in: ["PENDING", "FAILED"] } },
                            { status: "PROCESSING", leaseExpiresAt: { $lt: now } },
                            {
                                status: "PROCESSING",
                                leaseExpiresAt: { $exists: false },
                                lastAttemptAt: { $lt: new Date(now.getTime() - SYNC_LEASE_MS) },
                            },
                        ],
                    },
                ],
            },
            {
                $set: {
                    status: "PROCESSING",
                    lastAttemptAt: now,
                    leaseToken,
                    leaseExpiresAt: new Date(now.getTime() + SYNC_LEASE_MS),
                },
                $unset: { errorMessage: "", failureKind: "" },
                $inc: { attempts: 1 },
            },
            { returnDocument: "after" }
        );

        if (!operation) {
            const current = await SyncOperation.findById(existingOperation._id).lean();

            // Not claimed because the owner changed after step 2.
            if (
                current &&
                (!current.deviceId?.equals(user.deviceId) ||
                    (current.userId && !current.userId.equals(user.userId)))
            ) {
                throw new SyncProcessError(
                    403,
                    "OWNER_MISMATCH",
                    "This operation belongs to another user or device",
                    false
                );
            }

            if (current?.status === "SYNCED") {
                let existingSale = null;
                if (current.entityType === "Sale") {
                    existingSale = await Sale.findOne({ tenantId: user.tenantId, operationId: current.operationId }).lean();
                }
                return {
                    success: true,
                    alreadySynced: true,
                    operation: current,
                    result: existingSale
                        ? {
                            _id: existingSale._id,
                            invoiceNo: existingSale.invoiceNo,
                            provisionalInvoiceNo: existingSale.provisionalInvoiceNo,
                        }
                        : undefined,
                };
            }

            if (current?.status === "PROCESSING") {
                const waitMs = current.leaseExpiresAt
                    ? current.leaseExpiresAt.getTime() - Date.now()
                    : SYNC_LEASE_MS;
                throw new SyncProcessError(
                    409,
                    "IN_PROGRESS",
                    "Operation is already being processed",
                    true,
                    Math.max(1, Math.ceil(waitMs / 1000))
                );
            }

            if (current?.status === "NEEDS_ATTENTION" || (current && current.attempts >= MAX_SYNC_ATTEMPTS)) {
                throw new SyncProcessError(422, "NEEDS_ATTENTION", "Operation needs attention", false);
            }

            throw new SyncProcessError(409, "IN_PROGRESS", "Operation could not be claimed; try again", true, 5);
        }

        try {
            // 6. The device must still be active in this tenant and, for
            //    legacy records, belong to the session's user.
            const device = await Device.findOne({
                _id: operation.deviceId,
                tenantId: user.tenantId,
                status: "active",
            }).lean();

            if (!device) {
                throw new Error("Sync device not found, inactive, or does not belong to this tenant");
            }

            if (!operation.userId && !device.userId.equals(user.userId)) {
                throw new SyncProcessError(
                    403,
                    "OWNER_MISMATCH",
                    "This operation belongs to another user or device",
                    false
                );
            }

            // 7. Business effects are attributed to the uploading user.
            //    (Steps 2 and 6 guarantee this is the session's user.)
            const businessUser = {
                userId: operation.userId ?? device.userId,
                tenantId: user.tenantId,
                deviceId: operation.deviceId,
            };

            // 7b. The user's CURRENT role must allow this operation. A
            //     refusal is permanent: the operation needs review.
            //     (Unmapped types never get here, see step 4b; re-checked
            //     on the claimed record anyway, denying by default.)
            const requiredPermission = getSyncEntityPermission(operation.entityType);

            if (!requiredPermission) {
                throw new SyncProcessError(
                    403,
                    "PERMISSION_DENIED",
                    "This type of operation cannot be synchronized; it needs review",
                    false
                );
            }

            const granted = await getGrantedBusinessPermissions(
                {
                    userId: user.userId.toString(),
                    tenantId: user.tenantId.toString(),
                    roleId: user.roleId,
                },
                [
                    requiredPermission,
                    BUSINESS_PERMISSIONS.salesPriceOverride,
                    BUSINESS_PERMISSIONS.salesBackdate,
                ]
            );

            if (!granted.has(requiredPermission)) {
                throw new SyncProcessError(
                    403,
                    "PERMISSION_DENIED",
                    "You no longer have permission for this operation; it needs review",
                    false
                );
            }

            // Sale rules for offline sales: the date window is measured from
            // when the server first received the operation (server time).
            const salePolicy: SalePolicy = {
                allowPriceOverride: granted.has(BUSINESS_PERMISSIONS.salesPriceOverride),
                allowBackdate: granted.has(BUSINESS_PERMISSIONS.salesBackdate),
                referenceTime: operation.createdAt ?? new Date(),
                maxAgeMs: SALE_DATE_RULES.syncMaxAgeMs,
            };

            const payload = getPayloadObject(operation.payload);

            // 8. Idempotent business operation (see the per-entity services).
            const opResult: any = await SyncService.runBusinessOperation(
                businessUser,
                operation.entityType,
                payload,
                operation.operationId,
                salePolicy,
                operation.operationType
            );

            // 9. Mark SYNCED. Normally only the lease holder may do this. If
            //    the lease expired meanwhile and another worker reclaimed the
            //    operation, the effect is already committed (idempotent), so
            //    it is still safe to mark it SYNCED.
            const synced =
                (await SyncOperation.findOneAndUpdate(
                    { _id: operation._id, tenantId: user.tenantId, status: "PROCESSING", leaseToken },
                    {
                        $set: {
                            status: "SYNCED",
                            syncedAt: new Date(),
                            ...(opResult?._id ? { entityId: opResult._id } : {}),
                        },
                        $unset: { errorMessage: "", failureKind: "", leaseToken: "", leaseExpiresAt: "" },
                    },
                    { returnDocument: "after" }
                )) ??
                (await SyncOperation.findOneAndUpdate(
                    { _id: operation._id, tenantId: user.tenantId, status: { $in: ["PROCESSING", "SYNCED"] } },
                    {
                        $set: {
                            status: "SYNCED",
                            syncedAt: new Date(),
                            ...(opResult?._id ? { entityId: opResult._id } : {}),
                        },
                        $unset: { errorMessage: "", failureKind: "", leaseToken: "", leaseExpiresAt: "" },
                    },
                    { returnDocument: "after" }
                ));

            if (!synced) {
                // The business effect is committed, but the status could not
                // be recorded. Report a temporary failure: a later retry
                // reclaims the expired lease, finds the existing record
                // (idempotent) and marks it SYNCED.
                throw new SyncProcessError(
                    503,
                    "RETRYABLE_FAILURE",
                    "Operation was applied but its sync status could not be saved; retry later",
                    true
                );
            }

            return {
                success: true,
                alreadySynced: false,
                operation: synced,
                result: opResult
                    ? {
                        _id: (opResult as any)._id,
                        invoiceNo: (opResult as any).invoiceNo,
                        provisionalInvoiceNo: (opResult as any).provisionalInvoiceNo,
                        SKU: (opResult as any).SKU,
                        name: (opResult as any).name,
                    }
                    : undefined,
            };
        } catch (error: unknown) {
            if (error instanceof SyncProcessError && error.code === "RETRYABLE_FAILURE") {
                // Leave the lease in place; it expires and the retry recovers.
                throw error;
            }

            const kind =
                error instanceof SyncProcessError
                    ? error.retryable ? "RETRYABLE" : "PERMANENT"
                    : classifySyncError(error);
            const next = statusAfterFailure(kind, operation.attempts);

            // Only sanitized text is stored on the operation and returned to
            // the client (no database, driver or programming error detail).
            const errorMessage = publicSyncErrorMessage(error);

            if (!(error instanceof SyncProcessError)) {
                // Server log: error class and code only, never the message
                // (it may hold key values or infrastructure detail).
                const errorCode = (error as { code?: unknown } | null)?.code;
                console.error(
                    "Sync processing error:",
                    error instanceof Error ? error.name : "unknown",
                    typeof errorCode === "number" || typeof errorCode === "string" ? errorCode : ""
                );
            }

            // Release the lease (only if we still hold it).
            await SyncOperation.updateOne(
                { _id: operation._id, tenantId: user.tenantId, status: "PROCESSING", leaseToken },
                {
                    $set: { status: next.status, failureKind: next.failureKind, errorMessage },
                    $unset: { leaseToken: "", leaseExpiresAt: "" },
                }
            ).catch(() => {
                // The lease simply expires; a later attempt recovers.
            });

            if (error instanceof SyncProcessError) {
                throw error;
            }

            if (next.status === "NEEDS_ATTENTION") {
                throw new SyncProcessError(
                    422,
                    kind === "PERMANENT" ? "PERMANENT_FAILURE" : "NEEDS_ATTENTION",
                    kind === "PERMANENT"
                        ? `Sync failed permanently: ${errorMessage}`
                        : "Sync failed too many times and needs attention",
                    false
                );
            }

            throw new SyncProcessError(
                503,
                "RETRYABLE_FAILURE",
                "Temporary problem while syncing; it will be retried",
                true
            );
        }
    }

    private static async runBusinessOperation(
        businessUser: {
            userId: mongoose.Types.ObjectId;
            tenantId: mongoose.Types.ObjectId;
            deviceId: mongoose.Types.ObjectId;
        },
        entityType: string,
        payload: Record<string, unknown>,
        operationId: string,
        salePolicy: SalePolicy,
        operationType?: string
    ) {
        const operation = { entityType, operationId, operationType };

        switch (operation.entityType) {
            case "Sale": {
                return await SalesService.createSale(
                    businessUser,
                    parseSalePayload(payload),
                    operation.operationId,
                    salePolicy
                );
            }

            case "Purchase": {
                await PurchaseService.createPurchase(
                    businessUser,
                    parsePurchasePayload(payload),
                    operation.operationId
                );
                break;
            }

            case "SalesReturn": {
                await SalesReturnService.createSalesReturn(
                    businessUser,
                    parseSalesReturnPayload(payload),
                    operation.operationId
                );
                break;
            }

            case "PurchaseReturn": {
                await PurchaseReturnService.createPurchaseReturn(
                    businessUser,
                    parsePurchaseReturnPayload(payload),
                    operation.operationId
                );
                break;
            }

            case "Payment": {
                await PaymentService.createPayment(
                    businessUser,
                    parsePaymentPayload(payload),
                    operation.operationId
                );
                break;
            }

            case "StockAdjustment": {
                const stockAdjustment =
                    parseStockAdjustmentPayload(payload);

                await StockService.changeStock(
                    businessUser,
                    {
                        productId:
                            stockAdjustment.productId,

                        quantity:
                            stockAdjustment.quantity,

                        type: "adjustment",

                        warehouse: {
                            name:
                                stockAdjustment.warehouse.name,

                            location:
                                stockAdjustment.warehouse.location,
                        },

                        reason:
                            stockAdjustment.reason,
                    },
                    undefined,
                    operation.operationId
                );

                break;
            }

            case "Customer": {
                if (operation.operationType === "UPDATE") {
                    return await CustomerSyncService.updateCustomerFromSync(
                        businessUser,
                        payload,
                        operation.operationId
                    );
                }
                return await CustomerSyncService.createCustomerFromSync(
                    businessUser,
                    payload,
                    operation.operationId
                );
            }

            case "Supplier": {
                throw new Error(
                    "Supplier synchronization is not implemented yet"
                );
            }

            case "Product": {
                return await ProductSyncService.createProductFromSync(
                    businessUser,
                    payload,
                    operation.operationId
                );
            }

            default: {
                throw new Error(
                    `Unsupported sync entity: ${operation.entityType}`
                );
            }
        }
    }
}
