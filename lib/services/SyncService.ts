import mongoose from "mongoose";

import { SyncOperation } from "@/lib/models/SyncOperation";
import { Device } from "@/lib/models/Device";

import { SalesService } from "@/lib/services/SalesService";
import { PurchaseService } from "@/lib/services/PurchaseService";
import { SalesReturnService } from "@/lib/services/SalesReturnService";
import { PurchaseReturnService } from "@/lib/services/PurchaseReturnService";
import { PaymentService } from "@/lib/services/PaymentService";

export interface SyncUserContext {
    tenantId: mongoose.Types.ObjectId;
}

export class SyncService {
    static async processOperation(
        user: SyncUserContext,
        operationId: string
    ) {
        // ----------------------------------------------------------
        // 1. Validate tenant
        // ----------------------------------------------------------

        if (!user.tenantId) {
            throw new Error(
                "Tenant context is required"
            );
        }

        // ----------------------------------------------------------
        // 2. Validate operation ID
        // ----------------------------------------------------------

        if (!operationId?.trim()) {
            throw new Error(
                "Operation ID is required"
            );
        }

        const normalizedOperationId =
            operationId.trim();

        // ----------------------------------------------------------
        // 3. Find sync operation
        // ----------------------------------------------------------

        const existingOperation =
            await SyncOperation.findOne({
                tenantId:
                    user.tenantId,

                operationId:
                    normalizedOperationId,
            });

        if (!existingOperation) {
            throw new Error(
                "Sync operation not found"
            );
        }

        // ----------------------------------------------------------
        // 4. Already synced
        // ----------------------------------------------------------

        if (
            existingOperation.status ===
            "SYNCED"
        ) {
            return {
                success: true,

                alreadySynced: true,

                operation:
                    existingOperation,
            };
        }

        // ----------------------------------------------------------
        // 5. Already processing
        // ----------------------------------------------------------

        if (
            existingOperation.status ===
            "PROCESSING"
        ) {
            throw new Error(
                "Sync operation is already being processed"
            );
        }

        // ----------------------------------------------------------
        // 6. Claim operation
        // ----------------------------------------------------------

        const operation =
            await SyncOperation.findOneAndUpdate(
                {
                    _id:
                        existingOperation._id,

                    tenantId:
                        user.tenantId,

                    status: {
                        $in: [
                            "PENDING",
                            "FAILED",
                        ],
                    },
                },
                {
                    $set: {
                        status:
                            "PROCESSING",

                        lastAttemptAt:
                            new Date(),

                        errorMessage:
                            undefined,
                    },

                    $inc: {
                        attempts: 1,
                    },
                },
                {
                    new: true,
                }
            );

        if (!operation) {
            throw new Error(
                "Sync operation could not be claimed. It may already be processing."
            );
        }

        try {
            // ------------------------------------------------------
            // 7. Validate device
            // ------------------------------------------------------

            const device =
                await Device.findOne({
                    _id:
                        operation.deviceId,

                    tenantId:
                        user.tenantId,

                    status:
                        "active",
                }).lean();

            if (!device) {
                throw new Error(
                    "Sync device not found, inactive, or does not belong to this tenant"
                );
            }

            // ------------------------------------------------------
            // 8. Build business user context
            // ------------------------------------------------------

            const businessUser = {
                userId:
                    device.userId,

                tenantId:
                    user.tenantId,
            };

            // ------------------------------------------------------
            // 9. Validate payload
            // ------------------------------------------------------

            const payload =
                operation.payload;

            if (
                !payload ||
                typeof payload !==
                "object"
            ) {
                throw new Error(
                    "Sync operation payload is invalid"
                );
            }

            // ------------------------------------------------------
            // 10. Process business operation
            // ------------------------------------------------------

            switch (
            operation.entityType
            ) {
                // ==================================================
                // SALE
                // ==================================================

                case "Sale": {
                    /*
                     * IMPORTANT:
                     *
                     * We do NOT trust an operationId supplied
                     * inside the payload.
                     *
                     * The canonical operationId comes from the
                     * SyncOperation document itself.
                     */

                    await SalesService.createSale(
                        businessUser,

                        payload as any,

                        operation.operationId
                    );

                    break;
                }

                // ==================================================
                // PURCHASE
                // ==================================================

                case "Purchase": {
                    await PurchaseService.createPurchase(
                        businessUser,
                        payload as any,
                        operation.operationId
                    );

                    break;
                }

                // ==================================================
                // SALES RETURN
                // ==================================================

                case "SalesReturn": {
                    await SalesReturnService.createSalesReturn(
                        businessUser,

                        payload as any
                    );

                    break;
                }

                // ==================================================
                // PURCHASE RETURN
                // ==================================================

                case "PurchaseReturn": {
                    await PurchaseReturnService.createPurchaseReturn(
                        businessUser,
                        payload as any,
                        operation.operationId
                    );

                    break;
                }
                // ==================================================
                // PAYMENT
                // ==================================================

                case "Payment": {
                    await PaymentService.createPayment(
                        businessUser,

                        payload as any
                    );

                    break;
                }

                // ==================================================
                // CUSTOMER
                // ==================================================

                case "Customer": {
                    throw new Error(
                        "Customer synchronization is not implemented yet"
                    );
                }

                // ==================================================
                // SUPPLIER
                // ==================================================

                case "Supplier": {
                    throw new Error(
                        "Supplier synchronization is not implemented yet"
                    );
                }

                // ==================================================
                // PRODUCT
                // ==================================================

                case "Product": {
                    throw new Error(
                        "Product synchronization is not implemented yet"
                    );
                }

                // ==================================================
                // UNSUPPORTED
                // ==================================================

                default: {
                    throw new Error(
                        `Unsupported sync entity: ${operation.entityType}`
                    );
                }
            }

            // ------------------------------------------------------
            // 11. Mark sync operation as SYNCED
            // ------------------------------------------------------

            const syncedOperation =
                await SyncOperation.findOneAndUpdate(
                    {
                        _id:
                            operation._id,

                        tenantId:
                            user.tenantId,

                        status:
                            "PROCESSING",
                    },
                    {
                        $set: {
                            status:
                                "SYNCED",

                            syncedAt:
                                new Date(),
                        },

                        $unset: {
                            errorMessage:
                                "",
                        },
                    },
                    {
                        new: true,
                    }
                );

            if (!syncedOperation) {
                throw new Error(
                    "Operation was processed but could not be marked as SYNCED"
                );
            }

            // ------------------------------------------------------
            // 12. Return result
            // ------------------------------------------------------

            return {
                success: true,

                alreadySynced: false,

                operation:
                    syncedOperation,
            };
        } catch (error: unknown) {
            // ------------------------------------------------------
            // 13. Save failure information
            // ------------------------------------------------------

            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown sync error";

            await SyncOperation.findOneAndUpdate(
                {
                    _id:
                        operation._id,

                    tenantId:
                        user.tenantId,

                    status:
                        "PROCESSING",
                },
                {
                    $set: {
                        status:
                            "FAILED",

                        errorMessage,
                    },
                }
            );

            // ------------------------------------------------------
            // 14. Throw sync error
            // ------------------------------------------------------

            throw new Error(
                `Sync failed: ${errorMessage}`
            );
        }
    }
}