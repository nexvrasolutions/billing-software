import mongoose from "mongoose";
import { Counter } from "@/lib/models/Counter";
import { Supplier } from "@/lib/models/Supplier";

export class SupplierCodeService {
    /**
     * Atomically allocates the next sequential supplier code for a tenant.
     * Prevents collisions using MongoDB atomic upsert on the Counter collection
     * and verifies uniqueness against any existing or imported suppliers in the tenant.
     * This method must ONLY be called server-side.
     */
    static async generateNextSupplierCode(
        tenantId: mongoose.Types.ObjectId,
        session?: mongoose.ClientSession,
        prefix = "SUP",
        maxRetries = 10
    ): Promise<string> {
        if (typeof window !== "undefined") {
            throw new Error("SupplierCodeService cannot be executed in browser context");
        }

        const cleanPrefix = (prefix || "SUP").trim().toUpperCase();
        const counterKey = `supplier:${cleanPrefix}`;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const counter = await Counter.findOneAndUpdate(
                { tenantId, key: counterKey },
                { $inc: { seq: 1 } },
                {
                    upsert: true,
                    new: true,
                    setDefaultsOnInsert: true,
                    ...(session ? { session } : {}),
                }
            );

            const candidate = `${cleanPrefix}-${String(counter.seq).padStart(4, "0")}`;

            // Double check uniqueness in case of manually assigned or pre-existing codes
            const existingQuery = Supplier.findOne({ tenantId, supplierCode: candidate });
            if (session) {
                existingQuery.session(session);
            }
            const existing = await existingQuery.select("_id").lean();

            if (!existing) {
                return candidate;
            }
        }

        // Fallback with timestamp suffix if sequence space has collisions
        return `${cleanPrefix}-${Date.now().toString(36).toUpperCase()}`;
    }
}
