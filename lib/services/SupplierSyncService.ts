import mongoose from "mongoose";
import { Supplier, type ISupplier } from "@/lib/models/Supplier";
import { SupplierCodeService } from "@/lib/services/SupplierCodeService";
import { AuditLogService } from "@/lib/services/AuditLogService";
import { SyncProcessError } from "@/lib/services/SyncErrors";
import { GSTIN_PATTERN } from "@/lib/tax";
import { EMAIL_PATTERN, PAN_PATTERN } from "@/lib/validations/supplier";

export interface SupplierSyncUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
    deviceId?: mongoose.Types.ObjectId;
}

export interface SupplierCreateSyncResult {
    _id: string;
    supplierCode: string;
    localId?: string;
    name: string;
    alreadyProcessed?: boolean;
}

export interface SupplierUpdateSyncResult {
    _id: string;
    supplierCode: string;
    name: string;
}

const FORBIDDEN_BANKING_KEYS = [
    "bankDetails",
    "accountNumber",
    "bankName",
    "ifsc",
    "accountName",
    "upiId",
    "bankBranch",
    "swiftCode",
    "iban",
    "routingNumber",
];

function hasBankingFields(payload: Record<string, unknown>): boolean {
    return FORBIDDEN_BANKING_KEYS.some((key) => payload[key] !== undefined);
}

export class SupplierSyncService {
    /**
     * Create a supplier from an offline synchronization operation.
     * Enforces:
     * 1. Idempotency via operationId (retries return already-created supplier).
     * 2. Tenant isolation.
     * 3. Input validation & normalization using supplier validation rules.
     * 4. Rejection of lifecycle status, deletion, and banking-field changes.
     * 5. Server-side sequential supplier code allocation via SupplierCodeService.
     * 6. Audit logging with sensitive banking data excluded.
     * 7. Returning mapping information (localId, serverId, supplierCode) for reconciliation.
     */
    static async createSupplierFromSync(
        user: SupplierSyncUserContext,
        payload: Record<string, unknown>,
        operationId: string
    ): Promise<SupplierCreateSyncResult> {
        const normalizedOperationId = operationId.trim();
        if (!normalizedOperationId) {
            throw new SyncProcessError(
                400,
                "INVALID_REQUEST",
                "operationId is required for syncing a supplier",
                false
            );
        }

        // 1. Idempotency Check: if this exact operation already created a supplier, return it.
        const existingByOpId = await Supplier.findOne({
            tenantId: user.tenantId,
            operationId: normalizedOperationId,
        });

        if (existingByOpId) {
            return {
                _id: existingByOpId._id.toString(),
                supplierCode: existingByOpId.supplierCode,
                localId: typeof payload.localId === "string" ? payload.localId : undefined,
                name: existingByOpId.name,
                alreadyProcessed: true,
            };
        }

        // 2. Reject sensitive banking fields
        if (hasBankingFields(payload)) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Banking details cannot be synchronized via offline sync.",
                false
            );
        }

        // 3. Reject lifecycle and deletion fields through offline create
        if (payload.action !== undefined || payload.isDeleted === true) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Supplier lifecycle and deletion actions are online-only.",
                false
            );
        }

        if (payload.status !== undefined && payload.status !== "active") {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Offline supplier creation must have active status.",
                false
            );
        }

        // 4. Validate and normalize payload fields
        if (payload.name !== undefined && typeof payload.name !== "string") {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Supplier name must be a string",
                false
            );
        }
        const name = typeof payload.name === "string" ? payload.name.trim() : "";
        if (!name || name.length > 200) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Supplier name is required (max 200 characters)",
                false
            );
        }

        if (payload.contactPerson !== undefined && payload.contactPerson !== null) {
            if (typeof payload.contactPerson !== "string") {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Contact person must be a string",
                    false
                );
            }
            if (payload.contactPerson.trim().length > 200) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Contact person cannot exceed 200 characters",
                    false
                );
            }
        }
        const contactPerson =
            typeof payload.contactPerson === "string" && payload.contactPerson.trim().length > 0
                ? payload.contactPerson.trim()
                : undefined;

        if (payload.phone !== undefined && payload.phone !== null) {
            if (typeof payload.phone !== "string") {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Phone number must be a string",
                    false
                );
            }
            if (payload.phone.trim().length > 30) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Phone number cannot exceed 30 characters",
                    false
                );
            }
        }
        const phone =
            typeof payload.phone === "string" && payload.phone.trim().length > 0
                ? payload.phone.trim()
                : undefined;

        if (payload.altPhone !== undefined && payload.altPhone !== null) {
            if (typeof payload.altPhone !== "string") {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Alt phone number must be a string",
                    false
                );
            }
            if (payload.altPhone.trim().length > 30) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Alt phone number cannot exceed 30 characters",
                    false
                );
            }
        }
        const altPhone =
            typeof payload.altPhone === "string" && payload.altPhone.trim().length > 0
                ? payload.altPhone.trim()
                : undefined;

        if (payload.email !== undefined && payload.email !== null) {
            if (typeof payload.email !== "string") {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Email must be a string",
                    false
                );
            }
            const trimmedEmail = payload.email.trim();
            if (trimmedEmail.length > 0) {
                if (trimmedEmail.length > 200 || !EMAIL_PATTERN.test(trimmedEmail)) {
                    throw new SyncProcessError(
                        422,
                        "PERMANENT_FAILURE",
                        "Invalid supplier email format",
                        false
                    );
                }
            }
        }
        const email =
            typeof payload.email === "string" && payload.email.trim().length > 0
                ? payload.email.trim().toLowerCase()
                : undefined;

        if (payload.website !== undefined && payload.website !== null) {
            if (typeof payload.website !== "string") {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Website must be a string",
                    false
                );
            }
            if (payload.website.trim().length > 200) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Website cannot exceed 200 characters",
                    false
                );
            }
        }
        const website =
            typeof payload.website === "string" && payload.website.trim().length > 0
                ? payload.website.trim()
                : undefined;

        if (payload.line1 !== undefined && payload.line1 !== null && typeof payload.line1 !== "string") {
            throw new SyncProcessError(422, "PERMANENT_FAILURE", "Address line1 must be a string", false);
        }
        if (payload.address !== undefined && payload.address !== null && typeof payload.address !== "string") {
            throw new SyncProcessError(422, "PERMANENT_FAILURE", "Address must be a string", false);
        }
        const line1 =
            typeof payload.line1 === "string" && payload.line1.trim().length > 0
                ? payload.line1.trim()
                : typeof payload.address === "string" && payload.address.trim().length > 0
                ? payload.address.trim()
                : undefined;
        if (line1 && line1.length > 500) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Address line1 cannot exceed 500 characters",
                false
            );
        }

        if (payload.line2 !== undefined && payload.line2 !== null) {
            if (typeof payload.line2 !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Address line2 must be a string", false);
            }
            if (payload.line2.trim().length > 500) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Address line2 cannot exceed 500 characters",
                    false
                );
            }
        }
        const line2 =
            typeof payload.line2 === "string" && payload.line2.trim().length > 0
                ? payload.line2.trim()
                : undefined;

        if (payload.city !== undefined && payload.city !== null) {
            if (typeof payload.city !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "City must be a string", false);
            }
            if (payload.city.trim().length > 100) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "City cannot exceed 100 characters",
                    false
                );
            }
        }
        const city =
            typeof payload.city === "string" && payload.city.trim().length > 0
                ? payload.city.trim()
                : undefined;

        if (payload.state !== undefined && payload.state !== null) {
            if (typeof payload.state !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "State must be a string", false);
            }
            if (payload.state.trim().length > 100) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "State cannot exceed 100 characters",
                    false
                );
            }
        }
        const state =
            typeof payload.state === "string" && payload.state.trim().length > 0
                ? payload.state.trim()
                : undefined;

        if (payload.pincode !== undefined && payload.pincode !== null) {
            if (typeof payload.pincode !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Pincode must be a string", false);
            }
            if (payload.pincode.trim().length > 20) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Pincode cannot exceed 20 characters",
                    false
                );
            }
        }
        const pincode =
            typeof payload.pincode === "string" && payload.pincode.trim().length > 0
                ? payload.pincode.trim()
                : undefined;

        if (payload.country !== undefined && payload.country !== null) {
            if (typeof payload.country !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Country must be a string", false);
            }
            if (payload.country.trim().length > 100) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Country cannot exceed 100 characters",
                    false
                );
            }
        }
        const country =
            typeof payload.country === "string" && payload.country.trim().length > 0
                ? payload.country.trim()
                : "India";

        if (payload.gstin !== undefined && payload.gstin !== null) {
            if (typeof payload.gstin !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "GSTIN must be a string", false);
            }
            const trimmedGstin = payload.gstin.trim();
            if (trimmedGstin.length > 0 && !GSTIN_PATTERN.test(trimmedGstin.toUpperCase())) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Invalid GSTIN format (15 alphanumeric characters expected)",
                    false
                );
            }
        }
        const gstin =
            typeof payload.gstin === "string" && payload.gstin.trim().length > 0
                ? payload.gstin.trim().toUpperCase()
                : undefined;

        if (payload.pan !== undefined && payload.pan !== null) {
            if (typeof payload.pan !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "PAN must be a string", false);
            }
            const trimmedPan = payload.pan.trim();
            if (trimmedPan.length > 0 && !PAN_PATTERN.test(trimmedPan.toUpperCase())) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Invalid PAN format (10 characters expected)",
                    false
                );
            }
        }
        const pan =
            typeof payload.pan === "string" && payload.pan.trim().length > 0
                ? payload.pan.trim().toUpperCase()
                : undefined;

        if (payload.paymentType !== undefined && payload.paymentType !== null) {
            if (payload.paymentType !== "cash" && payload.paymentType !== "credit") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Payment type must be cash or credit", false);
            }
        }
        const paymentType: "cash" | "credit" =
            payload.paymentType === "credit" ? "credit" : "cash";

        let creditDays = 0;
        if (payload.creditDays !== undefined && payload.creditDays !== null && payload.creditDays !== "") {
            const cd = Number(payload.creditDays);
            if (isNaN(cd) || cd < 0 || cd > 3650 || !Number.isInteger(cd)) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Credit days must be an integer between 0 and 3650",
                    false
                );
            }
            creditDays = cd;
        }

        let creditLimit = 0;
        if (payload.creditLimit !== undefined && payload.creditLimit !== null && payload.creditLimit !== "") {
            const cl = Number(payload.creditLimit);
            if (isNaN(cl) || cl < 0 || !Number.isFinite(cl)) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Credit limit must be a non-negative number",
                    false
                );
            }
            creditLimit = cl;
        }

        if (payload.category !== undefined && payload.category !== null) {
            if (typeof payload.category !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Category must be a string", false);
            }
            if (payload.category.trim().length > 100) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Category cannot exceed 100 characters",
                    false
                );
            }
        }
        const category =
            typeof payload.category === "string" && payload.category.trim().length > 0
                ? payload.category.trim()
                : undefined;

        if (payload.notes !== undefined && payload.notes !== null) {
            if (typeof payload.notes !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Notes must be a string", false);
            }
            if (payload.notes.trim().length > 1000) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Notes cannot exceed 1000 characters",
                    false
                );
            }
        }
        const notes =
            typeof payload.notes === "string" && payload.notes.trim().length > 0
                ? payload.notes.trim()
                : undefined;

        // 5. Code allocation: offline creations use temporary codes (SUP-TEMP-...).
        // Allocate official sequential code from SupplierCodeService.
        let session: mongoose.ClientSession | null = null;
        try {
            session = await mongoose.startSession().catch(() => null);
        } catch {
            session = null;
        }

        try {
            let createdSupplier: any = null;

            const executeCreation = async (sess?: mongoose.ClientSession) => {
                const supplierCode = await SupplierCodeService.generateNextSupplierCode(
                    user.tenantId,
                    sess
                );

                const supplierDoc = {
                    tenantId: user.tenantId,
                    operationId: normalizedOperationId,
                    supplierCode,
                    name,
                    contact: {
                        contactPerson,
                        phone,
                        altPhone,
                        email,
                        website,
                    },
                    address: {
                        line1,
                        line2,
                        city,
                        state,
                        country,
                        pincode,
                    },
                    tax: {
                        gstin,
                        pan,
                        taxRegistrationType: (gstin ? "registered" : "unregistered") as "registered" | "unregistered",
                    },
                    paymentTerms: {
                        type: paymentType,
                        creditDays,
                        dueDateCalculation: "invoiceDate" as const,
                    },
                    creditLimit,
                    currency: "INR",
                    category,
                    notes,
                    status: "active" as const,
                    isDeleted: false,
                    createdBy: user.userId,
                };

                let supplier: any;
                if (sess) {
                    const created = await Supplier.create([supplierDoc], { session: sess });
                    supplier = Array.isArray(created) ? created[0] : created;
                } else {
                    supplier = await Supplier.create(supplierDoc);
                }

                await AuditLogService.createAuditLog(
                    {
                        userId: user.userId,
                        tenantId: user.tenantId,
                        deviceId: user.deviceId,
                    },
                    {
                        action: "CREATE",
                        entity: "Supplier",
                        entityId: supplier._id,
                        description: `Supplier ${supplier.name} (${supplier.supplierCode}) created via offline sync`,
                        newValues: {
                            supplierCode: supplier.supplierCode,
                            name: supplier.name,
                            contactPerson: supplier.contact?.contactPerson,
                            phone: supplier.contact?.phone,
                            email: supplier.contact?.email,
                            gstin: supplier.tax?.gstin,
                            paymentType: supplier.paymentTerms?.type,
                            creditDays: supplier.paymentTerms?.creditDays,
                            status: supplier.status,
                            operationId: normalizedOperationId,
                        },
                    },
                    sess
                );

                createdSupplier = supplier;
            };

            if (session) {
                await session.withTransaction(async () => {
                    await executeCreation(session!);
                });
            } else {
                await executeCreation();
            }

            if (!createdSupplier) {
                throw new SyncProcessError(
                    500,
                    "RETRYABLE_FAILURE",
                    "Supplier creation transaction failed to commit",
                    true
                );
            }

            return {
                _id: createdSupplier._id.toString(),
                supplierCode: createdSupplier.supplierCode,
                localId: typeof payload.localId === "string" ? payload.localId : undefined,
                name: createdSupplier.name,
            };
        } finally {
            if (session) {
                await session.endSession().catch(() => {});
            }
        }
    }

    /**
     * Update an existing supplier's profile details from an offline synchronization operation.
     * Enforces:
     * 1. Tenant boundary and supplier existence check.
     * 2. Strict rejection of lifecycle actions (deactivate, block, reactivate, unblock, delete) and banking fields.
     * 3. Input validation using supplier validation rules.
     * 4. Audit logging with sensitive data omitted.
     */
    static async updateSupplierFromSync(
        user: SupplierSyncUserContext,
        payload: Record<string, unknown>,
        operationId: string
    ): Promise<SupplierUpdateSyncResult> {
        const normalizedOperationId = operationId.trim();
        if (!normalizedOperationId) {
            throw new SyncProcessError(
                400,
                "INVALID_REQUEST",
                "operationId is required for supplier update",
                false
            );
        }

        // 1. Reject banking fields
        if (hasBankingFields(payload)) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Banking details cannot be modified via offline sync.",
                false
            );
        }

        // 2. Reject lifecycle and status transitions
        if (payload.action !== undefined || payload.isDeleted !== undefined || payload.status !== undefined) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Supplier lifecycle actions (deactivate, block, reactivate, unblock, delete) are online-only.",
                false
            );
        }

        // 3. Validate supplier ID
        const rawId = String(payload.supplierId || payload._id || payload.id || "").trim();
        if (!rawId || !mongoose.isValidObjectId(rawId)) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "A valid supplier ID is required for supplier update",
                false
            );
        }

        const supplierObjectId = new mongoose.Types.ObjectId(rawId);

        // 4. Find existing non-deleted supplier in this tenant
        const existing = await Supplier.findOne({
            _id: supplierObjectId,
            tenantId: user.tenantId,
            isDeleted: { $ne: true },
        });

        if (!existing) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Supplier not found for this tenant",
                false
            );
        }

        // 5. Validate update fields
        const updateData: Record<string, unknown> = {};

        if (payload.name !== undefined) {
            if (typeof payload.name !== "string") {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Supplier name must be a string",
                    false
                );
            }
            const name = payload.name.trim();
            if (!name || name.length > 200) {
                throw new SyncProcessError(
                    422,
                    "PERMANENT_FAILURE",
                    "Supplier name cannot be empty (max 200 characters)",
                    false
                );
            }
            updateData.name = name;
        }

        if (payload.contactPerson !== undefined) {
            if (payload.contactPerson !== null && typeof payload.contactPerson !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Contact person must be a string", false);
            }
            const cp = typeof payload.contactPerson === "string" ? payload.contactPerson.trim() : "";
            if (cp.length > 200) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Contact person cannot exceed 200 characters", false);
            }
            updateData["contact.contactPerson"] = cp.length > 0 ? cp : undefined;
        }

        if (payload.phone !== undefined) {
            if (payload.phone !== null && typeof payload.phone !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Phone number must be a string", false);
            }
            const p = typeof payload.phone === "string" ? payload.phone.trim() : "";
            if (p.length > 30) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Phone number cannot exceed 30 characters", false);
            }
            updateData["contact.phone"] = p.length > 0 ? p : undefined;
        }

        if (payload.altPhone !== undefined) {
            if (payload.altPhone !== null && typeof payload.altPhone !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Alt phone number must be a string", false);
            }
            const ap = typeof payload.altPhone === "string" ? payload.altPhone.trim() : "";
            if (ap.length > 30) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Alt phone number cannot exceed 30 characters", false);
            }
            updateData["contact.altPhone"] = ap.length > 0 ? ap : undefined;
        }

        if (payload.email !== undefined) {
            if (payload.email !== null && typeof payload.email !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Email must be a string", false);
            }
            const em = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
            if (em.length > 0 && (em.length > 200 || !EMAIL_PATTERN.test(em))) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Invalid email format", false);
            }
            updateData["contact.email"] = em.length > 0 ? em : undefined;
        }

        if (payload.website !== undefined) {
            if (payload.website !== null && typeof payload.website !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Website must be a string", false);
            }
            const web = typeof payload.website === "string" ? payload.website.trim() : "";
            if (web.length > 200) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Website cannot exceed 200 characters", false);
            }
            updateData["contact.website"] = web.length > 0 ? web : undefined;
        }

        const addressLine = payload.line1 !== undefined ? payload.line1 : payload.address;
        if (addressLine !== undefined) {
            if (addressLine !== null && typeof addressLine !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Address line1 must be a string", false);
            }
            const a = typeof addressLine === "string" ? addressLine.trim() : "";
            if (a.length > 500) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Address cannot exceed 500 characters", false);
            }
            updateData["address.line1"] = a.length > 0 ? a : undefined;
        }

        if (payload.line2 !== undefined) {
            if (payload.line2 !== null && typeof payload.line2 !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Address line2 must be a string", false);
            }
            const l2 = typeof payload.line2 === "string" ? payload.line2.trim() : "";
            if (l2.length > 500) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Address line2 cannot exceed 500 characters", false);
            }
            updateData["address.line2"] = l2.length > 0 ? l2 : undefined;
        }

        if (payload.city !== undefined) {
            if (payload.city !== null && typeof payload.city !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "City must be a string", false);
            }
            const c = typeof payload.city === "string" ? payload.city.trim() : "";
            if (c.length > 100) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "City cannot exceed 100 characters", false);
            }
            updateData["address.city"] = c.length > 0 ? c : undefined;
        }

        if (payload.state !== undefined) {
            if (payload.state !== null && typeof payload.state !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "State must be a string", false);
            }
            const s = typeof payload.state === "string" ? payload.state.trim() : "";
            if (s.length > 100) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "State cannot exceed 100 characters", false);
            }
            updateData["address.state"] = s.length > 0 ? s : undefined;
        }

        if (payload.pincode !== undefined) {
            if (payload.pincode !== null && typeof payload.pincode !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Pincode must be a string", false);
            }
            const pin = typeof payload.pincode === "string" ? payload.pincode.trim() : "";
            if (pin.length > 20) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Pincode cannot exceed 20 characters", false);
            }
            updateData["address.pincode"] = pin.length > 0 ? pin : undefined;
        }

        if (payload.country !== undefined) {
            if (payload.country !== null && typeof payload.country !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Country must be a string", false);
            }
            const cntry = typeof payload.country === "string" ? payload.country.trim() : "";
            if (cntry.length > 100) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Country cannot exceed 100 characters", false);
            }
            updateData["address.country"] = cntry.length > 0 ? cntry : undefined;
        }

        if (payload.gstin !== undefined) {
            if (payload.gstin !== null && typeof payload.gstin !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "GSTIN must be a string", false);
            }
            const g = typeof payload.gstin === "string" ? payload.gstin.trim().toUpperCase() : "";
            if (g.length > 0 && !GSTIN_PATTERN.test(g)) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Invalid GSTIN format (15 alphanumeric characters expected)", false);
            }
            updateData["tax.gstin"] = g.length > 0 ? g : undefined;
            updateData["tax.taxRegistrationType"] = g.length > 0 ? "registered" : "unregistered";
        }

        if (payload.pan !== undefined) {
            if (payload.pan !== null && typeof payload.pan !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "PAN must be a string", false);
            }
            const pn = typeof payload.pan === "string" ? payload.pan.trim().toUpperCase() : "";
            if (pn.length > 0 && !PAN_PATTERN.test(pn)) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Invalid PAN format (10 characters expected)", false);
            }
            updateData["tax.pan"] = pn.length > 0 ? pn : undefined;
        }

        if (payload.paymentType !== undefined) {
            if (payload.paymentType !== "cash" && payload.paymentType !== "credit") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Payment type must be cash or credit", false);
            }
            updateData["paymentTerms.type"] = payload.paymentType;
        }

        if (payload.creditDays !== undefined) {
            if (payload.creditDays === null || payload.creditDays === "") {
                updateData["paymentTerms.creditDays"] = 0;
            } else {
                const cd = Number(payload.creditDays);
                if (isNaN(cd) || cd < 0 || cd > 3650 || !Number.isInteger(cd)) {
                    throw new SyncProcessError(422, "PERMANENT_FAILURE", "Credit days must be an integer between 0 and 3650", false);
                }
                updateData["paymentTerms.creditDays"] = cd;
            }
        }

        if (payload.creditLimit !== undefined) {
            if (payload.creditLimit === null || payload.creditLimit === "") {
                updateData.creditLimit = 0;
            } else {
                const cl = Number(payload.creditLimit);
                if (isNaN(cl) || cl < 0 || !Number.isFinite(cl)) {
                    throw new SyncProcessError(422, "PERMANENT_FAILURE", "Credit limit must be a non-negative number", false);
                }
                updateData.creditLimit = cl;
            }
        }

        if (payload.category !== undefined) {
            if (payload.category !== null && typeof payload.category !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Category must be a string", false);
            }
            const cat = typeof payload.category === "string" ? payload.category.trim() : "";
            if (cat.length > 100) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Category cannot exceed 100 characters", false);
            }
            updateData.category = cat.length > 0 ? cat : undefined;
        }

        if (payload.notes !== undefined) {
            if (payload.notes !== null && typeof payload.notes !== "string") {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Notes must be a string", false);
            }
            const nts = typeof payload.notes === "string" ? payload.notes.trim() : "";
            if (nts.length > 1000) {
                throw new SyncProcessError(422, "PERMANENT_FAILURE", "Notes cannot exceed 1000 characters", false);
            }
            updateData.notes = nts.length > 0 ? nts : undefined;
        }

        if (Object.keys(updateData).length === 0) {
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                "Provide at least one profile field to update",
                false
            );
        }

        const updated = await Supplier.findOneAndUpdate(
            {
                _id: supplierObjectId,
                tenantId: user.tenantId,
                isDeleted: { $ne: true },
            },
            { $set: updateData },
            { new: true }
        );

        if (!updated) {
            throw new SyncProcessError(
                404,
                "PERMANENT_FAILURE",
                "Supplier not found or already deleted",
                false
            );
        }

        // Audit log event
        await AuditLogService.createAuditLog(
            {
                userId: user.userId,
                tenantId: user.tenantId,
                deviceId: user.deviceId,
            },
            {
                action: "UPDATE",
                entity: "Supplier",
                entityId: updated._id,
                description: `Supplier ${updated.name} (${updated.supplierCode}) updated via offline sync`,
                oldValues: {
                    name: existing.name,
                    contactPerson: existing.contact?.contactPerson,
                    phone: existing.contact?.phone,
                    email: existing.contact?.email,
                    gstin: existing.tax?.gstin,
                },
                newValues: {
                    name: updated.name,
                    contactPerson: updated.contact?.contactPerson,
                    phone: updated.contact?.phone,
                    email: updated.contact?.email,
                    gstin: updated.tax?.gstin,
                },
            }
        );

        return {
            _id: updated._id.toString(),
            supplierCode: updated.supplierCode,
            name: updated.name,
        };
    }
}
