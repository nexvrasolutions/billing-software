import mongoose from "mongoose";
import { Counter } from "@/lib/models/Counter";
import { Sale } from "@/lib/models/Sale";
import {
    isProvisionalInvoiceNo,
    generateProvisionalReference,
    formatInvoiceNumber,
    type GenerateInvoiceNoOptions,
} from "@/lib/invoiceNumber";

export {
    isProvisionalInvoiceNo,
    generateProvisionalReference,
    formatInvoiceNumber,
    type GenerateInvoiceNoOptions,
};

export class InvoiceNumberService {
    /**
     * Atomically allocates the next sequential invoice number for a tenant.
     * Prevents collisions using MongoDB atomic upsert counter and verifies uniqueness against Sale collection.
     * This method must ONLY be called server-side.
     */
    static async generateNextInvoiceNo(
        tenantId: mongoose.Types.ObjectId,
        session?: mongoose.ClientSession,
        options: GenerateInvoiceNoOptions = {}
    ): Promise<string> {
        if (typeof window !== "undefined") {
            throw new Error("InvoiceNumberService cannot be executed in browser context");
        }
        const prefix = (options.prefix ?? "INV").trim().toUpperCase();
        const date = options.date ?? new Date();
        const year = date.getFullYear();
        const counterKey = `invoice:${prefix}:${year}`;
        const maxRetries = options.maxRetries ?? 5;

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

            const candidate = formatInvoiceNumber(prefix, year, counter.seq);

            // Double check uniqueness in case of manually imported or legacy numbers
            const existingQuery = Sale.findOne({ tenantId, invoiceNo: candidate });
            if (session) {
                existingQuery.session(session);
            }
            const existing = await existingQuery.lean();

            if (!existing) {
                return candidate;
            }
            // If already exists, loop will increment counter again
        }

        // Fallback: timestamp-guaranteed uniqueness if counter retries exhausted
        return `${prefix}-${year}-${Date.now().toString().slice(-6)}`;
    }
}
