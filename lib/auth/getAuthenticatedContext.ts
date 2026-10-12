import { NextRequest } from "next/server";
import { connectDB } from "@/lib/db/mongodb";
import { User } from "@/lib/models/User";
import { Tenant } from "@/lib/models/Tenant";
import { Device } from "@/lib/models/Device";
import { getSession } from "./getSession";

export interface AuthenticatedContext {
    userId: string;
    tenantId: string;
    deviceId: string;
    roleId?: string;
}

export interface AuthenticatedContextOptions {
    /**
     * Allow users who must change their password (after an administrator
     * reset). Only the password-change and logout endpoints opt in; every
     * other route rejects such users by default (fail closed).
     */
    allowPasswordChangeRequired?: boolean;
}

export async function getAuthenticatedContext(
    request: NextRequest,
    options: AuthenticatedContextOptions = {}
): Promise<AuthenticatedContext | null> {
    // 1. Read and verify session
    const session =
        await getSession(request);

    if (!session) {
        return null;
    }

    // 2. Connect to database
    await connectDB();

    // 3. Verify active user belongs to tenant
    const user = await User.findOne({
        _id: session.userId,
        tenantId: session.tenantId,
        status: "active",
    }).lean();

    if (!user) {
        return null;
    }

    // 3b. A user with an administrator-set temporary password may only
    //     change it (or log out) until they choose their own password.
    if (
        user.mustChangePassword === true &&
        !options.allowPasswordChangeRequired
    ) {
        return null;
    }

    // 4. Verify active tenant
    const tenant = await Tenant.findOne({
        _id: session.tenantId,
        status: "active",
    }).lean();

    if (!tenant) {
        return null;
    }

    // 5. Verify device belongs to
    //    both this user and this tenant
    const device = await Device.findOne({
        _id: session.deviceId,
        tenantId: session.tenantId,
        userId: session.userId,
        status: "active",
    }).lean();

    if (!device) {
        return null;
    }

    // 6. Return trusted server-side context
    return {
        userId: user._id.toString(),
        tenantId: tenant._id.toString(),
        deviceId: device._id.toString(),
        roleId:
            user.roleId?.toString(),
    };
}