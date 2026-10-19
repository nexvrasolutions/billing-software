import mongoose from "mongoose";
import { Product } from "@/lib/models/Product";
import { Category } from "@/lib/models/Category";
import { Unit } from "@/lib/models/Unit";
import { AuditLogService } from "@/lib/services/AuditLogService";
import { StockService } from "@/lib/services/StockService";
import { SyncProcessError } from "@/lib/services/SyncErrors";
import { getGrantedPermissions } from "@/lib/auth/hasPermission";
import { PRODUCT_COST_PERMISSIONS, hasCostPermission } from "@/lib/catalog/productProjection";

export interface ProductSyncUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
    deviceId?: mongoose.Types.ObjectId;
}

export class ProductSyncService {
    /**
     * Create a product from an uploaded offline synchronization operation.
     * Enforces idempotency, tenant boundary, SKU/barcode uniqueness, active category/unit
     * verification, cost-price permission checks, and atomic initial opening stock movements.
     */
    static async createProductFromSync(
        user: ProductSyncUserContext,
        payload: Record<string, unknown>,
        operationId: string
    ): Promise<{ _id: string; SKU: string; name: string; alreadyProcessed?: boolean }> {
        const normalizedOperationId = operationId.trim();
        if (!normalizedOperationId) {
            throw new SyncProcessError(400, "INVALID_REQUEST", "operationId is required for syncing a product", false);
        }

        // 1. Idempotency Check: if this exact operation already created a product, return it.
        const existingByOpId = await Product.findOne({
            tenantId: user.tenantId,
            operationId: normalizedOperationId,
        });

        if (existingByOpId) {
            return {
                _id: existingByOpId._id.toString(),
                SKU: existingByOpId.SKU,
                name: existingByOpId.name,
                alreadyProcessed: true,
            };
        }

        // 2. Extract and validate payload fields
        const name = typeof payload.name === "string" ? payload.name.trim() : "";
        const rawSku = typeof payload.SKU === "string" ? payload.SKU.trim() : "";
        const barcode = typeof payload.barcode === "string" && payload.barcode.trim()
            ? payload.barcode.trim().toUpperCase()
            : undefined;
        const categoryId = typeof payload.categoryId === "string" ? payload.categoryId.trim() : "";
        const unitId = typeof payload.unitId === "string" ? payload.unitId.trim() : "";
        const sellingPrice = typeof payload.sellingPrice === "number" ? payload.sellingPrice : Number(payload.sellingPrice);
        const purchasePrice = typeof payload.purchasePrice === "number" ? payload.purchasePrice : Number(payload.purchasePrice || 0);
        const taxRate = payload.taxRate !== undefined && payload.taxRate !== null ? Number(payload.taxRate) : undefined;
        const hsnCode = typeof payload.hsnCode === "string" && payload.hsnCode.trim() ? payload.hsnCode.trim() : undefined;
        const initialStock = payload.initialStock !== undefined && payload.initialStock !== null
            ? Number(payload.initialStock)
            : payload.openingStock !== undefined && payload.openingStock !== null
            ? Number(payload.openingStock)
            : 0;

        if (!name || name.length > 200) {
            throw new SyncProcessError(422, "PERMANENT_FAILURE", "Product name is required (max 200 characters)", false);
        }

        if (!rawSku || rawSku.length > 100) {
            throw new SyncProcessError(422, "PERMANENT_FAILURE", "Product SKU is required (max 100 characters)", false);
        }

        const sku = rawSku.toUpperCase();

        if (isNaN(sellingPrice) || sellingPrice < 0) {
            throw new SyncProcessError(422, "PERMANENT_FAILURE", "Valid non-negative selling price is required", false);
        }

        if (!mongoose.isValidObjectId(categoryId)) {
            throw new SyncProcessError(422, "PERMANENT_FAILURE", "Invalid category ID", false);
        }

        if (!mongoose.isValidObjectId(unitId)) {
            throw new SyncProcessError(422, "PERMANENT_FAILURE", "Invalid unit ID", false);
        }

        if (taxRate !== undefined && (isNaN(taxRate) || taxRate < 0 || taxRate > 100)) {
            throw new SyncProcessError(422, "PERMANENT_FAILURE", "Tax rate must be between 0 and 100", false);
        }

        if (isNaN(initialStock) || initialStock < 0) {
            throw new SyncProcessError(422, "PERMANENT_FAILURE", "Opening stock quantity must be non-negative", false);
        }

        // 3. Verify cost permission
        let allowedPurchasePrice = 0;
        try {
            const granted = await getGrantedPermissions({
                userId: user.userId.toString(),
                tenantId: user.tenantId.toString(),
                permissions: [...PRODUCT_COST_PERMISSIONS],
            });
            if (hasCostPermission(granted) && !isNaN(purchasePrice) && purchasePrice >= 0) {
                allowedPurchasePrice = purchasePrice;
            }
        } catch {
            allowedPurchasePrice = 0;
        }

        // 4. Validate category and unit exist and are active for this tenant
        const [category, unit] = await Promise.all([
            Category.findOne({
                _id: new mongoose.Types.ObjectId(categoryId),
                tenantId: user.tenantId,
                status: "active",
            }).select("_id").lean(),
            Unit.findOne({
                _id: new mongoose.Types.ObjectId(unitId),
                tenantId: user.tenantId,
                status: "active",
            }).select("_id").lean(),
        ]);

        if (!category) {
            throw new SyncProcessError(422, "PERMANENT_FAILURE", "Active category not found for this tenant", false);
        }

        if (!unit) {
            throw new SyncProcessError(422, "PERMANENT_FAILURE", "Active unit not found for this tenant", false);
        }

        // 5. Check for conflicts with existing products in this tenant
        const duplicateConditions: Record<string, unknown>[] = [
            { tenantId: user.tenantId, SKU: sku },
        ];
        if (barcode) {
            duplicateConditions.push({ tenantId: user.tenantId, barcode });
        }

        const duplicate = await Product.findOne({
            $or: duplicateConditions,
        }).select("_id SKU barcode operationId name").lean();

        if (duplicate) {
            if (duplicate.operationId === normalizedOperationId) {
                return {
                    _id: duplicate._id.toString(),
                    SKU: duplicate.SKU,
                    name: duplicate.name,
                    alreadyProcessed: true,
                };
            }

            const isSkuConflict = duplicate.SKU === sku;
            throw new SyncProcessError(
                422,
                "PERMANENT_FAILURE",
                isSkuConflict
                    ? `A product with SKU "${sku}" already exists on the server.`
                    : `A product with barcode "${barcode}" already exists on the server.`,
                false
            );
        }

        // 6. Execute atomic creation within a session transaction
        const session = await mongoose.startSession();
        try {
            let createdProduct: any = null;

            await session.withTransaction(async () => {
                const [product] = await Product.create(
                    [
                        {
                            tenantId: user.tenantId,
                            operationId: normalizedOperationId,
                            name,
                            SKU: sku,
                            ...(barcode ? { barcode } : {}),
                            categoryId: new mongoose.Types.ObjectId(categoryId),
                            unitId: new mongoose.Types.ObjectId(unitId),
                            sellingPrice,
                            purchasePrice: allowedPurchasePrice,
                            stockQuantity: 0,
                            ...(taxRate !== undefined ? { taxRate } : {}),
                            ...(hsnCode ? { hsnCode } : {}),
                            status: "active",
                        },
                    ],
                    { session }
                );

                await AuditLogService.createAuditLog(
                    {
                        userId: user.userId,
                        tenantId: user.tenantId,
                        deviceId: user.deviceId,
                    },
                    {
                        action: "CREATE",
                        entity: "Product",
                        entityId: product._id,
                        description: `Product ${product.name} created via offline sync`,
                        newValues: {
                            name: product.name,
                            SKU: product.SKU,
                            barcode: product.barcode,
                            categoryId: product.categoryId,
                            unitId: product.unitId,
                            sellingPrice: product.sellingPrice,
                            purchasePrice: product.purchasePrice,
                            taxRate: product.taxRate,
                            hsnCode: product.hsnCode,
                            status: product.status,
                            operationId: normalizedOperationId,
                        },
                    },
                    session
                );

                // 7. Apply opening stock if requested, using idempotent operationId convention
                if (initialStock > 0) {
                    await StockService.changeStock(
                        {
                            userId: user.userId,
                            tenantId: user.tenantId,
                        },
                        {
                            productId: product._id.toString(),
                            quantity: initialStock,
                            type: "adjustment",
                            warehouse: { name: "Default" },
                            reason: "Initial opening stock",
                        },
                        session,
                        `${normalizedOperationId}:opening-stock`
                    );
                }

                createdProduct = product;
            });

            if (!createdProduct) {
                throw new SyncProcessError(500, "RETRYABLE_FAILURE", "Product creation transaction did not commit", true);
            }

            return {
                _id: createdProduct._id.toString(),
                SKU: createdProduct.SKU,
                name: createdProduct.name,
            };
        } finally {
            await session.endSession();
        }
    }
}
