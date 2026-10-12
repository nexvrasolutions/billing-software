
import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Tenant } from "../lib/models/Tenant";
import { Category } from "../lib/models/Category";
import { Unit } from "../lib/models/Unit";
import { Product } from "../lib/models/Product";

const TENANT_B_ID = "6ac62f56069cfae17a670203";

async function main() {
    await connectDB();

    const tenantId = new mongoose.Types.ObjectId(TENANT_B_ID);

    // Confirm Tenant B exists and is active.
    const tenant = await Tenant.findOne({
        _id: tenantId,
        status: "active",
    });

    if (!tenant) {
        throw new Error("Tenant B not found or inactive. No data created.");
    }

    // Create or reuse Tenant B's category.
    let category = await Category.findOne({
        tenantId,
        name: "Isolation Test Category",
    });

    if (!category) {
        category = await Category.create({
            tenantId,
            name: "Isolation Test Category",
            description: "Category for tenant-isolation testing",
            status: "active",
        });
    }

    // Create or reuse Tenant B's unit.
    let unit = await Unit.findOne({
        tenantId,
        name: "Isolation Test Piece",
    });

    if (!unit) {
        unit = await Unit.create({
            tenantId,
            name: "Isolation Test Piece",
            shortName: "pc",
            status: "active",
        });
    }

    // Create or reuse Tenant B's test product.
    let product = await Product.findOne({
        tenantId,
        SKU: "ISOLATION-TEST-001",
    });

    if (!product) {
        product = await Product.create({
            tenantId,
            name: "Isolation Test Product",
            SKU: "ISOLATION-TEST-001",
            categoryId: category._id,
            unitId: unit._id,
            purchasePrice: 10,
            sellingPrice: 15,
            stockQuantity: 0,
            status: "active",
        });
    }

    console.log("Tenant B test data is ready.");
    console.log("Tenant ID:", tenantId.toString());
    console.log("Category ID:", category._id.toString());
    console.log("Unit ID:", unit._id.toString());
    console.log("Product ID:", product._id.toString());
    console.log("Product tenant ID:", product.tenantId.toString());
}

main()
    .catch((error) => {
        console.error("Tenant B product setup failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
