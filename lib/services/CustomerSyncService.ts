import mongoose from "mongoose";
import { Customer } from "@/lib/models/Customer";
import { AuditLogService } from "@/lib/services/AuditLogService";
import { SyncProcessError } from "@/lib/services/SyncErrors";

export interface CustomerSyncUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
    deviceId?: mongoose.Types.ObjectId;
}

export class CustomerSyncService {
    /**
     * Create a customer from an offline synchronization operation.
     * Enforces idempotency via operationId, tenant boundary, input normalization,
     * duplicate phone check, and audit logging.
     */
    static async createCustomerFromSync(
        user: CustomerSyncUserContext,
        payload: Record<string, unknown>,
        operationId: string
    ): Promise<{ _id: string; name: string; alreadyProcessed?: boolean }> {
        const normalizedOperationId = operationId.trim();
        if (!normalizedOperationId) {
            throw new SyncProcessError(
                400,
                "INVALID_REQUEST",
                "operationId is required for syncing a customer",
                false
            );
        }

        // 1. Idempotency Check: if this exact operation already created a customer, return it.
        const existingByOpId = await Customer.findOne({
            tenantId: user.tenantId,
            operationId: normalizedOperationId,
        });

        if (existingByOpId) {
            return {
                _id: existingByOpId._id.toString(),
                name: existingByOpId.name,
                alreadyProcessed: true,
            };
        }

        // 2. Extract and validate payload fields
        const name = typeof payload.name === "string" ? payload.name.trim() : "";
        const phone =
            typeof payload.phone === "string" && payload.phone.trim().length > 0
                ? payload.phone.trim()
                : undefined;
        const email =
            typeof payload.email === "string" && payload.email.trim().length > 0
                ? payload.email.trim().toLowerCase()
                : undefined;
        const address =
            typeof payload.address === "string" && payload.address.trim().length > 0
                ? payload.address.trim()
                : undefined;
        const status: "active" | "inactive" =
            payload.status === "inactive" ? "inactive" : "active";

        if (!name || name.length > 200) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Customer name is required (max 200 characters)",
                false
            );
        }

        if (phone && phone.length > 30) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Phone number cannot exceed 30 characters",
                false
            );
        }

        if (email && (email.length > 200 || !email.includes("@"))) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Invalid customer email format",
                false
            );
        }

        // 3. Duplicate phone check within this tenant
        if (phone) {
            const duplicatePhone = await Customer.findOne({
                tenantId: user.tenantId,
                phone,
            }).select("_id name operationId").lean();

            if (duplicatePhone) {
                if (duplicatePhone.operationId === normalizedOperationId) {
                    return {
                        _id: duplicatePhone._id.toString(),
                        name: duplicatePhone.name,
                        alreadyProcessed: true,
                    };
                }

                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    `A customer with phone number "${phone}" already exists on the server.`,
                    false
                );
            }
        }

        // 4. Atomic customer creation with session transaction (if sessions supported)
        let session: mongoose.ClientSession | null = null;
        try {
            session = await mongoose.startSession().catch(() => null);
        } catch {
            session = null;
        }

        try {
            let createdCustomer: any = null;

            const executeCreation = async (sess?: mongoose.ClientSession) => {
                const docData = {
                    tenantId: user.tenantId,
                    operationId: normalizedOperationId,
                    name,
                    ...(phone ? { phone } : {}),
                    ...(email ? { email } : {}),
                    ...(address ? { address } : {}),
                    status,
                };

                const [customer] = sess
                    ? await Customer.create([docData], { session: sess })
                    : [await Customer.create(docData)];

                await AuditLogService.createAuditLog(
                    {
                        userId: user.userId,
                        tenantId: user.tenantId,
                        deviceId: user.deviceId,
                    },
                    {
                        action: "CREATE",
                        entity: "Customer",
                        entityId: customer._id,
                        description: `Customer ${customer.name} created via offline sync`,
                        newValues: {
                            name: customer.name,
                            phone: customer.phone,
                            email: customer.email,
                            address: customer.address,
                            status: customer.status,
                            operationId: normalizedOperationId,
                        },
                    },
                    sess
                );

                createdCustomer = customer;
            };

            if (session) {
                await session.withTransaction(async () => {
                    await executeCreation(session!);
                });
            } else {
                await executeCreation();
            }

            if (!createdCustomer) {
                throw new SyncProcessError(
                    500,
                    "RETRYABLE_FAILURE",
                    "Customer creation transaction failed to commit",
                    true
                );
            }

            return {
                _id: createdCustomer._id.toString(),
                name: createdCustomer.name,
            };
        } finally {
            if (session) {
                await session.endSession().catch(() => {});
            }
        }
    }

    /**
     * Update an existing customer from an offline synchronization operation.
     * Enforces tenant boundary, customer existence check, phone collision check, and audit logging.
     */
    static async updateCustomerFromSync(
        user: CustomerSyncUserContext,
        payload: Record<string, unknown>,
        operationId: string
    ): Promise<{ _id: string; name: string }> {
        const normalizedOperationId = operationId.trim();
        if (!normalizedOperationId) {
            throw new SyncProcessError(
                400,
                "INVALID_REQUEST",
                "operationId is required for customer update",
                false
            );
        }

        const rawId = String(payload.customerId || payload._id || payload.id || "").trim();
        if (!rawId || !mongoose.isValidObjectId(rawId)) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "A valid customer ID is required for customer update",
                false
            );
        }

        const customerObjectId = new mongoose.Types.ObjectId(rawId);

        // 1. Find existing customer in this tenant
        const existing = await Customer.findOne({
            _id: customerObjectId,
            tenantId: user.tenantId,
        });

        if (!existing) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Customer not found for this tenant",
                false
            );
        }

        // 2. Validate update fields
        const updates: Partial<{
            name: string;
            phone?: string;
            email?: string;
            address?: string;
            status: "active" | "inactive";
        }> = {};

        if (typeof payload.name === "string" && payload.name.trim().length > 0) {
            if (payload.name.trim().length > 200) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Customer name cannot exceed 200 characters",
                    false
                );
            }
            updates.name = payload.name.trim();
        }

        if (payload.phone !== undefined) {
            const rawPhone = typeof payload.phone === "string" ? payload.phone.trim() : "";
            const phone = rawPhone.length > 0 ? rawPhone : undefined;

            if (phone) {
                if (phone.length > 30) {
                    throw new SyncProcessError(
                        422,
                        "PERMANENT_FAILURE",
                        "Phone number cannot exceed 30 characters",
                        false
                    );
                }

                // Check collision with another customer
                const conflict = await Customer.findOne({
                    tenantId: user.tenantId,
                    phone,
                    _id: { $ne: customerObjectId },
                }).select("_id").lean();

                if (conflict) {
                    throw new SyncProcessError(
                        422,
                        "PERMANENT_FAILURE",
                        `A customer with phone number "${phone}" already exists on the server.`,
                        false
                    );
                }
            }

            updates.phone = phone;
        }

        if (payload.email !== undefined) {
            const rawEmail = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
            const email = rawEmail.length > 0 ? rawEmail : undefined;
            if (email && !email.includes("@")) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Invalid customer email format",
                    false
                );
            }
            updates.email = email;
        }

        if (payload.address !== undefined) {
            const rawAddress = typeof payload.address === "string" ? payload.address.trim() : "";
            updates.address = rawAddress.length > 0 ? rawAddress : undefined;
        }

        if (payload.status === "active" || payload.status === "inactive") {
            updates.status = payload.status;
        }

        const oldValues = {
            name: existing.name,
            phone: existing.phone,
            email: existing.email,
            address: existing.address,
            status: existing.status,
        };

        // Apply updates
        Object.assign(existing, updates);
        await existing.save();

        await AuditLogService.createAuditLog(
            {
                userId: user.userId,
                tenantId: user.tenantId,
                deviceId: user.deviceId,
            },
            {
                action: "UPDATE",
                entity: "Customer",
                entityId: existing._id,
                description: `Customer ${existing.name} updated via offline sync`,
                oldValues,
                newValues: {
                    name: existing.name,
                    phone: existing.phone,
                    email: existing.email,
                    address: existing.address,
                    status: existing.status,
                    operationId: normalizedOperationId,
                },
            }
        );

        return {
            _id: existing._id.toString(),
            name: existing.name,
        };
    }
}
