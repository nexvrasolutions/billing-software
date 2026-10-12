
import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { User } from "../lib/models/User";
import { hashPassword } from "../app/api/auth/password";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const TENANT_ID = "6abe48a86ae4b08a3e335303";
const TEST_EMAIL = "newuser@testbusiness.com";

async function main() {
    if (process.env.NODE_ENV === "production") {
        throw new Error("Development-only script; refusing to run in production.");
    }

    const password = process.env.TEST_USER_TEMP_PASSWORD;

    if (!password || password.length < 12) {
        throw new Error(
            "Set TEST_USER_TEMP_PASSWORD to a temporary password of at least 12 characters."
        );
    }

    await connectDB();

    const user = await User.findOne({
        email: TEST_EMAIL,
        tenantId: new mongoose.Types.ObjectId(TENANT_ID),
        status: "active",
    });

    if (!user) {
        throw new Error("Active test user not found in the specified tenant.");
    }

    user.passwordHash = await hashPassword(password);
    await user.save();

    console.log(`Temporary password set for ${TEST_EMAIL}.`);
}

main()
    .catch((error: unknown) => {
        console.error(
            "Password reset failed:",
            error instanceof Error ? error.message : "Unknown error"
        );
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
