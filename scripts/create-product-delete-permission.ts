
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Permission } from "../lib/models/Permission";

async function main() {
    try {
        await connectDB();

        const permission = await Permission.findOneAndUpdate(
            { name: "products.delete" },
            {
                $setOnInsert: {
                    name: "products.delete",
                    description: "Deactivate products",
                },
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true,
            }
        );

        console.log("Permission ready:", permission);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error("Failed to create product delete permission:", error);
    process.exitCode = 1;
});