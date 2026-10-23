/*
 * Product Filtering & Search Logic for Product Management
 *
 * Implements Stage 3: Product Management UI Polish
 *
 * Responsibilities:
 * 1. Filter products by name, SKU, and barcode (case-insensitive substring match).
 * 2. Filter products by category ID.
 * 3. Filter products by active/archived status while preserving archived items.
 * 4. Filter products by stock level (in-stock, low-stock, out-of-stock).
 * 5. Provide stock badge tone and formatting using the real API stockQuantity field.
 */

import { formatQuantity } from "@/lib/quantity";

export interface ProductItem {
    id: string;
    name: string;
    sku: string;
    barcode?: string;
    categoryId?: string;
    pricePaise: number;
    stockQuantity: number;
    active: boolean;
    syncStatus?: "PENDING" | "SYNCED" | "NEEDS_ATTENTION";
    errorMessage?: string;
}

export type ProductStatusFilter = "all" | "active" | "archived";
export type ProductStockFilter = "all" | "in-stock" | "low-stock" | "out-of-stock";

export interface ProductFilters {
    query?: string;
    categoryId?: string;
    status?: ProductStatusFilter;
    stockLevel?: ProductStockFilter;
}

/**
 * Filter an array of products based on search query, category, status, and stock level.
 */
export function filterProducts(products: ProductItem[], filters: ProductFilters): ProductItem[] {
    const query = (filters.query ?? "").trim().toLowerCase();
    const categoryId = filters.categoryId && filters.categoryId !== "all" ? filters.categoryId : undefined;
    const status = filters.status ?? "all";
    const stockLevel = filters.stockLevel ?? "all";

    return products.filter((p) => {
        // 1. Text search: matches name, SKU, or barcode
        if (query) {
            const nameMatch = p.name.toLowerCase().includes(query);
            const skuMatch = p.sku.toLowerCase().includes(query);
            const barcodeMatch = Boolean(p.barcode && p.barcode.toLowerCase().includes(query));

            if (!nameMatch && !skuMatch && !barcodeMatch) {
                return false;
            }
        }

        // 2. Category filter
        if (categoryId && p.categoryId !== categoryId) {
            return false;
        }

        // 3. Status filter (preserves archived products when "all" or "archived")
        if (status === "active" && !p.active) {
            return false;
        }
        if (status === "archived" && p.active) {
            return false;
        }

        // 4. Stock level filter
        if (stockLevel === "in-stock" && p.stockQuantity <= 0) {
            return false;
        }
        if (stockLevel === "out-of-stock" && p.stockQuantity > 0) {
            return false;
        }
        if (stockLevel === "low-stock" && (p.stockQuantity <= 0 || p.stockQuantity > 10)) {
            return false;
        }

        return true;
    });
}

/**
 * Format stock badge tone and text for UI rendering.
 */
export function formatStockBadge(stockQuantity: number): {
    label: string;
    tone: "normal" | "low" | "out";
} {
    if (stockQuantity <= 0) {
        return {
            label: "0 in stock",
            tone: "out",
        };
    }

    const formatted = formatQuantity(stockQuantity);

    if (stockQuantity <= 10) {
        return {
            label: `${formatted} in stock`,
            tone: "low",
        };
    }

    return {
        label: `${formatted} in stock`,
        tone: "normal",
    };
}
