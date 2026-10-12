
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Product } from "../lib/models/Product";

async function main() {
    try {
        await connectDB();

        const product = await Product.findById(
            "6ac898efbdd27fd9f705701d"
        )
            .select("name SKU tenantId stockQuantity")
            .lean();

        console.log("Verification result:", product);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});