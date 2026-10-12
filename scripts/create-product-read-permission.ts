
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

import { connectDB } from "../lib/db/mongodb";
import { Permission } from "../lib/models/Permission";

async function main() {
    await connectDB();

    const permission = await Permission.findOneAndUpdate(
        { name: "products.read" },
        {
            $setOnInsert: {
                name: "products.read",
                description: "View products",
            },
        },
        {
            upsert: true,
            returnDocument: "after",
        }
    );

    console.log("Product read permission ready:");
    console.log({
        id: permission?._id.toString(),
        name: permission?.name,
        description: permission?.description,
    });

    process.exitCode = 0;
}

main().catch((error) => {
    console.error("Failed to create product read permission:", error);
    process.exitCode = 1;
});