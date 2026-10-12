
import mongoose from "mongoose";
import dotenv from "dotenv";
import { connectDB } from "../lib/db/mongodb";
import { User } from "../lib/models/User";
import { hashPassword } from "../app/api/auth/password";

dotenv.config({ path: ".env.local" });

const TENANT_ID = "6abe48a86ae4b08a3e335303";
const ADMIN_ID = "6abe4d3f6ae4b08a3e335463";
const ADMIN_EMAIL = "admin@testbusiness.com";

async function main() {
    if (process.env.NODE_ENV === "production") {
        throw new Error("Development-only script. Refusing to run in production.");
    }

    const password = process.env.TEST_ADMIN_TEMP_PASSWORD;

    if (!password || password.length < 12) {
        throw new Error(
            "Set TEST_ADMIN_TEMP_PASSWORD to a temporary password of at least 12 characters."
        );
    }

    await connectDB();

    const user = await User.findOne({
        _id: new mongoose.Types.ObjectId(ADMIN_ID),
        tenantId: new mongoose.Types.ObjectId(TENANT_ID),
        email: ADMIN_EMAIL,
        status: "active",
    });

    if (!user) {
        throw new Error("Expected active development Admin was not found.");
    }

    user.passwordHash = await hashPassword(password);
    await user.save();

    console.log("Temporary password reset successfully for the development Admin.");
}

main()
    .catch((error: unknown) => {
        console.error(
            "Admin password reset failed:",
            error instanceof Error ? error.message : "Unknown error"
        );
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
