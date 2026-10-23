import mongoose from "mongoose";

import { Sale } from "@/lib/models/Sale";
import { Payment } from "@/lib/models/Payment";
import { Product } from "@/lib/models/Product";
import { InvoiceNumberService, isProvisionalInvoiceNo } from "@/lib/services/InvoiceNumberService";
import { Customer } from "@/lib/models/Customer";
import { Unit } from "@/lib/models/Unit";
import { Tenant } from "@/lib/models/Tenant";
import { StockService } from "@/lib/services/StockService";
import { LedgerService } from "@/lib/services/LedgerService";
import { AuditLogService } from "@/lib/services/AuditLogService";
import {
    BusinessPermissionError,
    SALE_DATE_RULES,
} from "@/lib/auth/businessPermissions";
import { SyncProcessError } from "@/lib/services/SyncErrors";
import {
    calculateSale,
    BillMathError,
    type CalculateSaleLineInput,
    type CalculateSaleResult,
} from "@/lib/bill-maths";

/**
 * Resolves the effective tax rate for a sale item.
 *
 * Distinguishes an explicit 0% tax rate from a missing/unconfigured tax rate.
 * - If both item.taxRate and product.taxRate are defined, verifies they match (rejects tampered rates).
 * - If item.taxRate is omitted, but product.taxRate is configured in the catalog (including 0), it is applied.
 * - If product.taxRate is omitted, but item.taxRate is explicitly specified (including 0), it is applied.
 * - If neither has a configured tax rate, throws a recoverable NEEDS_ATTENTION SyncProcessError.
 */
export function resolveItemTaxRate(
    itemTaxRate: unknown,
    productTaxRate: unknown,
    productInfo: { name: string; SKU?: string }
): number {
    const isNum = (v: unknown): v is number =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

    const hasItemRate = isNum(itemTaxRate);
    const hasProductRate = isNum(productTaxRate);

    if (hasItemRate && hasProductRate) {
        if (itemTaxRate !== productTaxRate) {
            const skuInfo = productInfo.SKU ? ` (${productInfo.SKU})` : "";
            throw new SyncProcessError(
                400,
                "INVALID_REQUEST",
                `Tax rate mismatch for product '${productInfo.name}'${skuInfo}: submitted rate ${itemTaxRate}% does not match configured catalog rate ${productTaxRate}%`,
                false
            );
        }
        return productTaxRate;
    }

    if (hasProductRate) {
        return productTaxRate;
    }

    if (hasItemRate) {
        return itemTaxRate;
    }

    const skuInfo = productInfo.SKU ? ` (${productInfo.SKU})` : "";
    throw new SyncProcessError(
        422,
        "NEEDS_ATTENTION",
        `Product '${productInfo.name}'${skuInfo} lacks tax configuration; tax treatment must be explicitly configured before this sale can be processed`,
        false
    );
}

export interface SalesUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
    // Device of the authenticated session (recorded in the audit log).
    deviceId?: mongoose.Types.ObjectId;
}

/**
 * What the caller is allowed to do beyond a plain sale. Computed from the
 * user's CURRENT permissions by the caller (route or sync processing).
 * When omitted, the strictest policy applies.
 */
export interface SalePolicy {
    // sales.priceOverride: a price other than the selling price, or a discount.
    allowPriceOverride: boolean;
    // sales.backdate: a sale date older than referenceTime - maxAgeMs.
    allowBackdate: boolean;
    // Online: now. Offline sync: when the server first received the operation.
    referenceTime: Date;
    maxAgeMs: number;
}

function strictSalePolicy(): SalePolicy {
    return {
        allowPriceOverride: false,
        allowBackdate: false,
        referenceTime: new Date(),
        maxAgeMs: SALE_DATE_RULES.onlineMaxAgeMs,
    };
}

/** Sale date after the date rules; throws when the date is not allowed. */
function resolveSaleDate(
    value: unknown,
    policy: SalePolicy,
    now: Date
): { saleDate: Date; backdated: boolean } {
    if (value === undefined || value === null || value === "") {
        return { saleDate: now, backdated: false };
    }

    const saleDate =
        value instanceof Date || typeof value === "string"
            ? new Date(value)
            : new Date(Number.NaN);

    if (!Number.isFinite(saleDate.getTime())) {
        throw new Error("Invalid sale date");
    }

    // Never in the future (beyond a small clock difference), whatever the
    // user's permissions.
    if (saleDate.getTime() > now.getTime() + SALE_DATE_RULES.maxFutureMs) {
        throw new Error("Sale date cannot be in the future");
    }

    const oldestAllowed = policy.referenceTime.getTime() - policy.maxAgeMs;
    const backdated = saleDate.getTime() < oldestAllowed;

    if (backdated && !policy.allowBackdate) {
        throw new BusinessPermissionError(
            "This sale date is too far in the past; it requires the sales.backdate permission"
        );
    }

    return { saleDate, backdated };
}

/** True for a duplicate-key error on the tenant's invoice-number index. */
function isDuplicateInvoiceError(error: unknown): boolean {
    const mongoError = error as { code?: unknown; keyPattern?: Record<string, unknown> } | null;
    return mongoError?.code === 11000 && Boolean(mongoError.keyPattern?.invoiceNo);
}

export interface SaleItemInput {
    productId: string;
    quantity: number;
    unitPrice?: number;
    discountRate?: number;
    discountAmount?: number;
    taxRate?: number;
}

export interface PaymentComponentInput {
    method: "cash" | "bank" | "upi" | "card";
    amount: number;
    referenceNo?: string;
    notes?: string;
}

export interface CreateSaleInput {
    invoiceNo: string;
    provisionalInvoiceNo?: string;

    customerId?: string;

    saleDate?: Date;

    warehouse: {
        name: string;
        location?: string;
    };

    items: SaleItemInput[];

    paidAmount?: number;

    paymentMethod?:
    | "cash"
    | "bank"
    | "upi"
    | "card"
    | "credit";

    paymentComponents?: PaymentComponentInput[];

    roundOff?: boolean;

    notes?: string;
}

export class SalesService {
    // ============================================================
    // CREATE SALE
    // ============================================================

    static async createSale(
        user: SalesUserContext,
        input: CreateSaleInput,
        operationId?: string,
        policy: SalePolicy = strictSalePolicy(),
        deps?: {
            pricingMode?: "tax_inclusive" | "tax_exclusive";
            getTenantPricingMode?: (tenantId: mongoose.Types.ObjectId) => Promise<"tax_inclusive" | "tax_exclusive">;
            generateInvoiceNo?: (tenantId: mongoose.Types.ObjectId, session: mongoose.ClientSession) => Promise<string>;
        }
    ) {
        const session =
            await mongoose.startSession();

        // Invoice numbers are stored upper-case and trimmed (schema), and
        // are unique per tenant (database index tenantId + invoiceNo).
        let invoiceNo =
            typeof input.invoiceNo === "string"
                ? input.invoiceNo.trim().toUpperCase()
                : "";

        let provisionalInvoiceNo =
            typeof input.provisionalInvoiceNo === "string" && input.provisionalInvoiceNo.trim()
                ? input.provisionalInvoiceNo.trim().toUpperCase()
                : undefined;

        if (!provisionalInvoiceNo && isProvisionalInvoiceNo(invoiceNo)) {
            provisionalInvoiceNo = invoiceNo;
        }

        /*
         * operationId is supplied by SyncService when the sale
         * comes from an offline synchronization operation.
         *
         * Online sales normally do not have an operationId.
         */
        const normalizedOperationId =
            operationId?.trim() || undefined;

        try {
            let createdSale = null;

            await session.withTransaction(
                async () => {
                    // ----------------------------------------------------
                    // 1. Validate user and tenant
                    // ----------------------------------------------------

                    if (!user.userId) {
                        throw new Error(
                            "Authenticated user is required"
                        );
                    }

                    if (!user.tenantId) {
                        throw new Error(
                            "Tenant context is required"
                        );
                    }

                    // ----------------------------------------------------
                    // 2. IDEMPOTENCY CHECK (FIRST before any number allocation)
                    // ----------------------------------------------------
                    //
                    // If this exact offline operation has already created
                    // a sale, return that existing sale immediately.
                    //
                    // This is what makes retrying the same operation safe,
                    // and ensures the invoice counter is NEVER burned or incremented.
                    // ----------------------------------------------------

                    if (normalizedOperationId) {
                        const existingOperationSale =
                            await Sale.findOne({
                                tenantId: user.tenantId,
                                operationId:
                                    normalizedOperationId,
                            }).session(session);

                        if (existingOperationSale) {
                            createdSale =
                                existingOperationSale;

                            return;
                        }
                    }

                    // ----------------------------------------------------
                    // 3. Resolve invoice number & provisional offline reference
                    // ----------------------------------------------------
                    // If input has no invoice number or it's a provisional reference,
                    // allocate an authoritative permanent invoice number on the server.

                    if (!invoiceNo || isProvisionalInvoiceNo(invoiceNo)) {
                        if (deps?.generateInvoiceNo) {
                            invoiceNo = (await deps.generateInvoiceNo(user.tenantId, session)).trim().toUpperCase();
                        } else {
                            try {
                                invoiceNo = await InvoiceNumberService.generateNextInvoiceNo(
                                    user.tenantId,
                                    session,
                                    { date: input.saleDate }
                                );
                            } catch {
                                if (!invoiceNo) {
                                    invoiceNo = provisionalInvoiceNo || "";
                                }
                            }
                        }
                    }

                    if (!invoiceNo) {
                        throw new Error(
                            "Invoice number is required"
                        );
                    }

                    // ----------------------------------------------------
                    // 4. Validate warehouse
                    // ----------------------------------------------------

                    if (!input.warehouse?.name?.trim()) {
                        throw new Error(
                            "Warehouse name is required"
                        );
                    }

                    // ----------------------------------------------------
                    // 5. Validate sale items
                    // ----------------------------------------------------

                    if (
                        !Array.isArray(input.items) ||
                        input.items.length === 0
                    ) {
                        throw new Error(
                            "At least one sale item is required"
                        );
                    }

                    // ----------------------------------------------------
                    // 5b. Sale date rules (future dates, backdating)
                    // ----------------------------------------------------

                    const { saleDate, backdated } =
                        resolveSaleDate(
                            input.saleDate,
                            policy,
                            new Date()
                        );

                    // ----------------------------------------------------
                    // 6. Check duplicate invoice
                    // ----------------------------------------------------
                    //
                    // The unique index (tenantId + invoiceNo) also rejects
                    // a concurrent duplicate; see the catch block below.

                    const existingInvoice =
                        await Sale.findOne({
                            tenantId: user.tenantId,
                            invoiceNo,
                        }).session(session);

                    if (existingInvoice) {
                        throw new Error(
                            `Invoice ${invoiceNo} already exists`
                        );
                    }

                    // ----------------------------------------------------
                    // 7. Find customer
                    // ----------------------------------------------------

                    let customer = null;

                    if (input.customerId) {
                        if (
                            !mongoose.isValidObjectId(
                                input.customerId
                            )
                        ) {
                            throw new Error(
                                "Invalid customer ID"
                            );
                        }

                        customer =
                            await Customer.findOne({
                                _id: input.customerId,
                                tenantId:
                                    user.tenantId,
                                status: "active",
                            }).session(session);

                        if (!customer) {
                            throw new Error(
                                "Customer not found or inactive"
                            );
                        }
                    }

                    // ----------------------------------------------------
                    // 7b. Resolve tenant pricing mode
                    // ----------------------------------------------------

                    let pricingMode: "tax_inclusive" | "tax_exclusive" = "tax_inclusive";
                    if (deps?.pricingMode) {
                        pricingMode = deps.pricingMode;
                    } else if (deps?.getTenantPricingMode) {
                        pricingMode = await deps.getTenantPricingMode(user.tenantId);
                    } else {
                        const tenantDoc = await Tenant.findById(user.tenantId).session(session).lean();
                        if (tenantDoc?.pricingMode === "tax_exclusive") {
                            pricingMode = "tax_exclusive";
                        } else {
                            pricingMode = "tax_inclusive";
                        }
                    }

                    // ----------------------------------------------------
                    // 8. Prepare sale items & validate against catalogue
                    // ----------------------------------------------------

                    const lineInputsForCalc: CalculateSaleLineInput[] = [];
                    const validatedProducts: {
                        product: any;
                        unit: any;
                        unitPrice: number;
                        discountRate: number;
                    }[] = [];
                    let priceOverridden = false;

                    // ----------------------------------------------------
                    // 9. Process each product
                    // ----------------------------------------------------

                    for (const item of input.items) {
                        // ------------------------------------------------
                        // Product ID validation
                        // ------------------------------------------------

                        if (
                            !mongoose.isValidObjectId(
                                item.productId
                            )
                        ) {
                            throw new Error(
                                `Invalid product ID: ${item.productId}`
                            );
                        }

                        // ------------------------------------------------
                        // Quantity validation
                        // ------------------------------------------------

                        if (
                            typeof item.quantity !== "number" ||
                            !Number.isFinite(
                                item.quantity
                            ) ||
                            item.quantity <= 0
                        ) {
                            throw new Error(
                                `Invalid quantity for product ${item.productId}`
                            );
                        }

                        // ------------------------------------------------
                        // Find product
                        // ------------------------------------------------

                        const product =
                            await Product.findOne({
                                _id: item.productId,
                                tenantId:
                                    user.tenantId,
                                status: "active",
                            }).session(session);

                        if (!product) {
                            throw new Error(
                                `Product not found or inactive: ${item.productId}`
                            );
                        }

                        // ------------------------------------------------
                        // Find unit
                        // ------------------------------------------------

                        const unit =
                            await Unit.findOne({
                                _id: product.unitId,
                                tenantId:
                                    user.tenantId,
                                status: "active",
                            }).session(session);

                        if (!unit) {
                            throw new Error(
                                `Unit not found for product ${product.name}`
                            );
                        }

                        // ------------------------------------------------
                        // Unit price
                        // ------------------------------------------------

                        const unitPrice =
                            item.unitPrice ??
                            product.sellingPrice;

                        if (
                            typeof unitPrice !== "number" ||
                            !Number.isFinite(
                                unitPrice
                            ) ||
                            unitPrice < 0
                        ) {
                            throw new Error(
                                `Invalid price for ${product.name}`
                            );
                        }

                        // ------------------------------------------------
                        // Discount
                        // ------------------------------------------------

                        const discountRate =
                            item.discountRate ?? 0;

                        if (
                            typeof discountRate !==
                            "number" ||
                            !Number.isFinite(
                                discountRate
                            ) ||
                            discountRate < 0 ||
                            discountRate > 100
                        ) {
                            throw new Error(
                                `Invalid discount rate for ${product.name}`
                            );
                        }

                        if (
                            item.discountAmount !== undefined &&
                            (typeof item.discountAmount !== "number" ||
                                !Number.isFinite(item.discountAmount) ||
                                item.discountAmount < 0)
                        ) {
                            throw new Error(
                                `Invalid discount amount for ${product.name}`
                            );
                        }

                        // ------------------------------------------------
                        // Price override / discount permission
                        // ------------------------------------------------

                        const lineOverridesPrice =
                            Math.abs(unitPrice - product.sellingPrice) > 1e-9 ||
                            discountRate > 0 ||
                            (item.discountAmount !== undefined && item.discountAmount > 0);

                        if (
                            lineOverridesPrice &&
                            !policy.allowPriceOverride
                        ) {
                            throw new BusinessPermissionError(
                                `Changing the price of ${product.name} or giving a discount requires the sales.priceOverride permission`
                            );
                        }

                        priceOverridden ||= lineOverridesPrice;

                        // ------------------------------------------------
                        // Tax rate resolution
                        // ------------------------------------------------

                        const taxRate = resolveItemTaxRate(
                            item.taxRate,
                            product.taxRate,
                            { name: product.name, SKU: product.SKU }
                        );

                        validatedProducts.push({
                            product,
                            unit,
                            unitPrice,
                            discountRate,
                        });

                        lineInputsForCalc.push({
                            productId: product._id.toString(),
                            name: product.name,
                            SKU: product.SKU,
                            quantity: item.quantity,
                            unitPrice,
                            discountRate,
                            discountAmount: item.discountAmount,
                            taxRate,
                        });
                    }

                    // ----------------------------------------------------
                    // 10. Unified calculation (pure, exact paise arithmetic)
                    // ----------------------------------------------------

                    let saleCalc: CalculateSaleResult;
                    try {
                        saleCalc = calculateSale({
                            lines: lineInputsForCalc,
                            pricingMode,
                            roundOff: input.roundOff === true,
                        });
                    } catch (mathErr) {
                        if (mathErr instanceof BillMathError) {
                            throw new SyncProcessError(
                                422,
                                "INVALID_REQUEST",
                                mathErr.message,
                                false
                            );
                        }
                        throw mathErr;
                    }

                    // ----------------------------------------------------
                    // 11. Build saleItems from authoritative calculation
                    // ----------------------------------------------------

                    const saleItems = saleCalc.lines.map((calcLine, index) => {
                        const vp = validatedProducts[index]!;
                        const itemInput = input.items[index]!;

                        return {
                            productId: vp.product._id,
                            productSnapshot: {
                                name: vp.product.name,
                                SKU: vp.product.SKU,
                                unit: vp.unit.shortName,
                            },
                            quantity: itemInput.quantity,
                            unitPrice: vp.unitPrice,
                            discountRate: vp.discountRate,
                            discountAmount: calcLine.discountAmount,
                            tax: {
                                rate: calcLine.taxRate,
                                amount: calcLine.taxAmount,
                            },
                            total: calcLine.lineTotal,
                        };
                    });

                    const subtotal = saleCalc.subtotal;
                    const discountTotal = saleCalc.discountTotal;
                    const taxTotal = saleCalc.taxTotal;
                    const shippingCost = 0;
                    const otherCharges = 0;
                    const roundOff = saleCalc.roundOff;
                    const grandTotal = saleCalc.grandTotal;

                    // ----------------------------------------------------
                    // 12. Validate paid amount
                    // ----------------------------------------------------

                    const paidAmount =
                        input.paidAmount ?? 0;

                    if (
                        typeof paidAmount !==
                        "number" ||
                        !Number.isFinite(
                            paidAmount
                        ) ||
                        paidAmount < 0
                    ) {
                        throw new Error(
                            "Invalid paid amount"
                        );
                    }

                    if (
                        paidAmount >
                        grandTotal
                    ) {
                        throw new Error(
                            "Paid amount cannot exceed grandTotal"
                        );
                    }

                    // ----------------------------------------------------
                    // 12b. Resolve and validate payment components
                    // ----------------------------------------------------

                    let resolvedComponents: PaymentComponentInput[] = [];

                    if (Array.isArray(input.paymentComponents) && input.paymentComponents.length > 0) {
                        resolvedComponents = input.paymentComponents;
                    } else if (paidAmount > 0 && input.paymentMethod && input.paymentMethod !== "credit") {
                        // Legacy single-method fallback
                        resolvedComponents = [
                            {
                                method: input.paymentMethod as "cash" | "bank" | "upi" | "card",
                                amount: paidAmount,
                            },
                        ];
                    }

                    if (paidAmount === 0) {
                        if (resolvedComponents.length > 0) {
                            const positiveSum = resolvedComponents.reduce(
                                (acc, c) => acc + (typeof c.amount === "number" ? c.amount : 0),
                                0
                            );
                            if (positiveSum > 0) {
                                throw new Error("Payment components cannot be provided when paidAmount is 0");
                            }
                        }
                    } else {
                        if (resolvedComponents.length === 0) {
                            throw new Error("Payment method or payment components are required when paidAmount > 0");
                        }

                        const allowedMethods = new Set(["cash", "bank", "upi", "card"]);
                        let totalPaise = 0n;

                        for (let i = 0; i < resolvedComponents.length; i++) {
                            const comp = resolvedComponents[i];
                            if (!comp || !allowedMethods.has(comp.method)) {
                                throw new Error(`Invalid payment component method at index ${i}: ${comp?.method}`);
                            }
                            if (
                                typeof comp.amount !== "number" ||
                                !Number.isFinite(comp.amount) ||
                                comp.amount <= 0
                            ) {
                                throw new Error(`Payment component amount must be positive at index ${i}`);
                            }

                            // Check precision (maximum 2 decimal places)
                            const scaled = Math.round(comp.amount * 100);
                            if (Math.abs(comp.amount * 100 - scaled) > 1e-4) {
                                throw new Error(`Payment component amount at index ${i} has more than 2 decimal places`);
                            }

                            totalPaise += BigInt(scaled);
                        }

                        const paidAmountPaise = BigInt(Math.round(paidAmount * 100));
                        if (totalPaise !== paidAmountPaise) {
                            throw new Error(
                                `Sum of payment components (${Number(totalPaise) / 100}) does not match paidAmount (${paidAmount})`
                            );
                        }
                    }

                    // ----------------------------------------------------
                    // 13. Calculate due amount
                    // ----------------------------------------------------

                    const dueAmount =
                        grandTotal -
                        paidAmount;

                    // ----------------------------------------------------
                    // 14. Payment status
                    // ----------------------------------------------------

                    let paymentStatus:
                        | "unpaid"
                        | "partial"
                        | "paid";

                    if (
                        paidAmount === 0
                    ) {
                        paymentStatus =
                            "unpaid";
                    } else if (
                        paidAmount <
                        grandTotal
                    ) {
                        paymentStatus =
                            "partial";
                    } else {
                        paymentStatus =
                            "paid";
                    }

                    // ----------------------------------------------------
                    // 15. Create sale document
                    // ----------------------------------------------------

                    const sale = new Sale({
                        tenantId:
                            user.tenantId,

                        /*
                         * IMPORTANT:
                         * Store the sync operation ID in the actual
                         * business transaction.
                         */
                        operationId:
                            normalizedOperationId,

                        invoiceNo,

                        provisionalInvoiceNo,

                        customerId:
                            customer?._id,

                        customerSnapshot:
                            customer
                                ? {
                                    name:
                                        customer.name,

                                    phone:
                                        customer.phone,

                                    email:
                                        customer.email,
                                }
                                : undefined,

                        saleDate,

                        warehouse: {
                            name:
                                input.warehouse.name.trim(),

                            location:
                                input.warehouse.location?.trim(),
                        },

                        items:
                            saleItems,

                        subtotal,

                        discountTotal,

                        taxTotal,

                        shippingCost,

                        otherCharges,

                        roundOff,

                        grandTotal,

                        paidAmount,

                        dueAmount,

                        paymentStatus,

                        paymentMethod:
                            input.paymentMethod ??
                            (resolvedComponents.length === 1
                                ? resolvedComponents[0]!.method
                                : undefined),

                        payments:
                            resolvedComponents.length > 0
                                ? resolvedComponents
                                : undefined,

                        status:
                            "completed",

                        notes:
                            input.notes,

                        createdBy:
                            user.userId,
                    });

                    // ----------------------------------------------------
                    // 16. Save sale
                    // ----------------------------------------------------

                    await sale.save({
                        session,
                    });

                    // ----------------------------------------------------
                    // 16b. Create atomic Payment receipt records
                    // ----------------------------------------------------

                    for (let i = 0; i < resolvedComponents.length; i++) {
                        const comp = resolvedComponents[i]!;
                        const paymentNo = `${sale.invoiceNo}-PAY-${i + 1}`;
                        const compOperationId = normalizedOperationId
                            ? `${normalizedOperationId}:pay:${i + 1}`
                            : undefined;

                        const payment = new Payment({
                            tenantId: user.tenantId,
                            operationId: compOperationId,
                            paymentNo,
                            type: "receipt",
                            amount: comp.amount,
                            paymentMethod: comp.method,
                            paymentDate: sale.saleDate,
                            customerId: sale.customerId,
                            saleId: sale._id,
                            referenceNo: comp.referenceNo,
                            notes: comp.notes,
                            status: "completed",
                            createdBy: user.userId,
                        });

                        await payment.save({ session });
                    }

                    // ----------------------------------------------------
                    // 17. Update stock
                    // ----------------------------------------------------

                    for (
                        const item of saleItems
                    ) {
                        await StockService.changeStock(
                            user,
                            {
                                productId:
                                    item.productId.toString(),

                                // Sale decreases stock
                                quantity:
                                    -item.quantity,

                                type:
                                    "sale",

                                warehouse: {
                                    name:
                                        input.warehouse.name.trim(),

                                    location:
                                        input.warehouse.location?.trim(),
                                },

                                referenceId:
                                    sale._id.toString(),

                                reason:
                                    `Sale ${sale.invoiceNo}`,
                            },
                            session
                        );
                    }

                    // ----------------------------------------------------
                    // 18. Create ledger entries (Double-entry balanced)
                    // ----------------------------------------------------

                    const ledgerEntries: any[] = [
                        {
                            transactionId:
                                sale._id.toString(),

                            transactionType:
                                "sale",

                            account:
                                "accounts_receivable",

                            entryType:
                                "debit",

                            amount:
                                sale.grandTotal,

                            customerId:
                                sale.customerId?.toString(),

                            description:
                                `Sale receivable - ${sale.invoiceNo}`,

                            entryDate:
                                sale.saleDate,
                        },

                        {
                            transactionId:
                                sale._id.toString(),

                            transactionType:
                                "sale",

                            account:
                                "sales_revenue",

                            entryType:
                                "credit",

                            amount:
                                sale.grandTotal,

                            description:
                                `Sales revenue - ${sale.invoiceNo}`,

                            entryDate:
                                sale.saleDate,
                        },
                    ];

                    for (const comp of resolvedComponents) {
                        const moneyAccount =
                            comp.method === "cash" ? "cash" : "bank";

                        ledgerEntries.push({
                            transactionId:
                                sale._id.toString(),

                            transactionType:
                                "sale",

                            account:
                                moneyAccount,

                            entryType:
                                "debit",

                            amount:
                                comp.amount,

                            customerId:
                                sale.customerId?.toString(),

                            description:
                                `Receipt (${comp.method.toUpperCase()}) - ${sale.invoiceNo}`,

                            entryDate:
                                sale.saleDate,
                        });

                        ledgerEntries.push({
                            transactionId:
                                sale._id.toString(),

                            transactionType:
                                "sale",

                            account:
                                "accounts_receivable",

                            entryType:
                                "credit",

                            amount:
                                comp.amount,

                            customerId:
                                sale.customerId?.toString(),

                            description:
                                `Payment applied - ${sale.invoiceNo}`,

                            entryDate:
                                sale.saleDate,
                        });
                    }

                    await LedgerService.createEntries(
                        user,
                        ledgerEntries,
                        session
                    );

                    // ----------------------------------------------------
                    // 18b. Audit log (same transaction: if it fails, the
                    //      sale, stock and ledger changes roll back)
                    // ----------------------------------------------------

                    await AuditLogService.createAuditLog(
                        {
                            userId: user.userId,
                            tenantId: user.tenantId,
                            deviceId: user.deviceId,
                        },
                        {
                            action: "CREATE",
                            entity: "Sale",
                            entityId: sale._id,
                            description:
                                `Sale ${sale.invoiceNo} created`,
                            newValues: {
                                invoiceNo: sale.invoiceNo,
                                provisionalInvoiceNo: sale.provisionalInvoiceNo,
                                saleDate: sale.saleDate,
                                grandTotal: sale.grandTotal,
                                paidAmount: sale.paidAmount,
                                paymentStatus: sale.paymentStatus,
                                itemCount: saleItems.length,
                                paymentsCount: resolvedComponents.length,
                                operationId: sale.operationId,
                                priceOverridden,
                                backdated,
                            },
                        },
                        session
                    );

                    // ----------------------------------------------------
                    // 19. Store created sale
                    // ----------------------------------------------------

                    createdSale =
                        sale;
                }
            );

            return createdSale;
        } catch (error: unknown) {
            /*
             * ----------------------------------------------------------
             * CONCURRENT IDEMPOTENCY PROTECTION
             * ----------------------------------------------------------
             *
             * Two sync requests could arrive at almost exactly the
             * same time.
             *
             * Both could initially see:
             *
             *     operationId = not found
             *
             * One transaction will successfully create the Sale.
             *
             * The second transaction will hit the unique
             * tenantId + operationId index.
             *
             * After its transaction is aborted, find the already
             * committed sale and return it.
             *
             * This prevents duplicate stock/ledger processing.
             * ----------------------------------------------------------
             */

            const mongoError =
                error as
                | mongoose.mongo.MongoServerError
                | undefined;

            if (
                normalizedOperationId &&
                mongoError?.code === 11000
            ) {
                const existingOperationSale =
                    await Sale.findOne({
                        tenantId:
                            user.tenantId,

                        operationId:
                            normalizedOperationId,
                    });

                if (
                    existingOperationSale
                ) {
                    return existingOperationSale;
                }
            }

            // A concurrent sale took this invoice number first.
            if (isDuplicateInvoiceError(error)) {
                throw new Error(
                    `Invoice ${invoiceNo} already exists`
                );
            }

            throw error;
        } finally {
            await session.endSession();
        }
    }

    // ============================================================
    // GET ONE SALE
    // ============================================================

    static async getSale(
        user: SalesUserContext,
        saleId: string
    ) {
        // ----------------------------------------------------------
        // Validate sale ID
        // ----------------------------------------------------------

        if (
            !mongoose.isValidObjectId(
                saleId
            )
        ) {
            throw new Error(
                "Invalid sale ID"
            );
        }

        // ----------------------------------------------------------
        // Find sale
        // ----------------------------------------------------------

        const sale =
            await Sale.findOne({
                _id: saleId,
                tenantId:
                    user.tenantId,
            });

        if (!sale) {
            throw new Error(
                "Sale not found"
            );
        }

        return sale;
    }

    // ============================================================
    // GET SALES
    // ============================================================

    static async getSales(
        user: SalesUserContext,
        options?: {
            page?: number;

            limit?: number;

            customerId?: string;

            paymentStatus?:
            | "unpaid"
            | "partial"
            | "paid";

            status?:
            | "draft"
            | "completed"
            | "cancelled";
        }
    ) {
        // ----------------------------------------------------------
        // Pagination
        // ----------------------------------------------------------

        const page = Math.max(
            options?.page ?? 1,
            1
        );

        const limit = Math.min(
            Math.max(
                options?.limit ?? 20,
                1
            ),
            100
        );

        // ----------------------------------------------------------
        // Base filter
        // ----------------------------------------------------------

        const filter: Record<
            string,
            unknown
        > = {
            tenantId:
                user.tenantId,
        };

        // ----------------------------------------------------------
        // Customer filter
        // ----------------------------------------------------------

        if (options?.customerId) {
            if (
                !mongoose.isValidObjectId(
                    options.customerId
                )
            ) {
                throw new Error(
                    "Invalid customer ID"
                );
            }

            filter.customerId =
                new mongoose.Types.ObjectId(
                    options.customerId
                );
        }

        // ----------------------------------------------------------
        // Payment status filter
        // ----------------------------------------------------------

        if (
            options?.paymentStatus
        ) {
            filter.paymentStatus =
                options.paymentStatus;
        }

        // ----------------------------------------------------------
        // Sale status filter
        // ----------------------------------------------------------

        if (options?.status) {
            filter.status =
                options.status;
        }

        // ----------------------------------------------------------
        // Calculate pagination
        // ----------------------------------------------------------

        const skip =
            (page - 1) * limit;

        // ----------------------------------------------------------
        // Fetch sales + total
        // ----------------------------------------------------------

        const [
            sales,
            total,
        ] = await Promise.all([
            Sale.find(filter)
                .sort({
                    saleDate: -1,
                    _id: -1,
                })
                .skip(skip)
                .limit(limit)
                .lean(),

            Sale.countDocuments(
                filter
            ),
        ]);

        // ----------------------------------------------------------
        // Return result
        // ----------------------------------------------------------

        return {
            sales,

            pagination: {
                page,

                limit,

                total,

                totalPages:
                    Math.ceil(
                        total / limit
                    ),
            },
        };
    }
}