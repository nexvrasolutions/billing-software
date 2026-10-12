
import { config } from "dotenv";
config({ path: ".env.local" });

import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Permission } from "../lib/models/Permission";

async function main() {
    await connectDB();

    const name = "products.update";
    const description = "Update product details";

    const existing = await Permission.findOne({ name });

    if (existing) {
        console.log(`Permission already exists: ${name}`);
        console.log("Permission ID:", existing._id.toString());
        return;
    }

    const permission = await Permission.create({
        name,
        description,
    });

    console.log("Permission created successfully.");
    console.log("Name:", permission.name);
    console.log("Permission ID:", permission._id.toString());
}

main()
    .catch((error) => {
        console.error("Permission creation failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });