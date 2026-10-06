import mongoose from "mongoose";
import { LedgerEntry } from "@/lib/models/LedgerEntry";

export interface LedgerUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
}

export type LedgerAccount =
    | "cash"
    | "bank"
    | "accounts_receivable"
    | "accounts_payable"
    | "sales_revenue"
    | "inventory"
    | "sales_return"
    | "purchase_return";

export type LedgerTransactionType =
    | "sale"
    | "purchase"
    | "receipt"
    | "payment"
    | "sales_refund"
    | "purchase_refund";

export interface LedgerEntryInput {
    transactionId: string;

    transactionType: LedgerTransactionType;

    account: LedgerAccount;

    entryType: "debit" | "credit";

    amount: number;

    customerId?: string;

    supplierId?: string;

    referenceId?: string;

    description?: string;

    entryDate?: Date;
}

export class LedgerService {
    static async createEntries(
        user: LedgerUserContext,
        entries: LedgerEntryInput[],
        session?: mongoose.ClientSession
    ) {
        // 1. Validate user
        if (!user.userId) {
            throw new Error(
                "Authenticated user is required"
            );
        }

        // 2. Validate tenant
        if (!user.tenantId) {
            throw new Error(
                "Tenant context is required"
            );
        }

        // 3. Validate entries
        if (
            !Array.isArray(entries) ||
            entries.length < 2
        ) {
            throw new Error(
                "At least two ledger entries are required"
            );
        }

        // 4. Get transaction ID
        const transactionId =
            entries[0].transactionId;

        if (
            !mongoose.isValidObjectId(
                transactionId
            )
        ) {
            throw new Error(
                "Invalid transaction ID"
            );
        }

        // 5. Get transaction type
        const transactionType =
            entries[0].transactionType;

        // 6. Validate every entry
        for (const entry of entries) {
            if (
                !mongoose.isValidObjectId(
                    entry.transactionId
                )
            ) {
                throw new Error(
                    "Invalid transaction ID"
                );
            }

            if (
                entry.transactionId !==
                transactionId
            ) {
                throw new Error(
                    "All ledger entries must belong to the same transaction"
                );
            }

            if (
                entry.transactionType !==
                transactionType
            ) {
                throw new Error(
                    "All ledger entries must have the same transaction type"
                );
            }

            if (
                typeof entry.amount !== "number" ||
                !Number.isFinite(entry.amount) ||
                entry.amount <= 0
            ) {
                throw new Error(
                    "Ledger amount must be greater than zero"
                );
            }

            if (
                entry.entryType !== "debit" &&
                entry.entryType !== "credit"
            ) {
                throw new Error(
                    "Invalid ledger entry type"
                );
            }

            if (
                entry.customerId &&
                !mongoose.isValidObjectId(
                    entry.customerId
                )
            ) {
                throw new Error(
                    "Invalid customer ID"
                );
            }

            if (
                entry.supplierId &&
                !mongoose.isValidObjectId(
                    entry.supplierId
                )
            ) {
                throw new Error(
                    "Invalid supplier ID"
                );
            }

            if (
                entry.referenceId &&
                !mongoose.isValidObjectId(
                    entry.referenceId
                )
            ) {
                throw new Error(
                    "Invalid reference ID"
                );
            }
        }

        // 7. Calculate Debit and Credit totals
        let totalDebit = 0;
        let totalCredit = 0;

        for (const entry of entries) {
            if (entry.entryType === "debit") {
                totalDebit += entry.amount;
            }

            if (entry.entryType === "credit") {
                totalCredit += entry.amount;
            }
        }

        // 8. Make sure the ledger is balanced
        if (
            Math.abs(
                totalDebit - totalCredit
            ) > 0.000001
        ) {
            throw new Error(
                `Ledger is not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`
            );
        }

        // 9. Prepare MongoDB documents
        const documents = entries.map(
            (entry) => ({
                tenantId: user.tenantId,

                transactionId:
                    new mongoose.Types.ObjectId(
                        entry.transactionId
                    ),

                transactionType:
                    entry.transactionType,

                account: entry.account,

                entryType:
                    entry.entryType,

                amount: entry.amount,

                customerId:
                    entry.customerId
                        ? new mongoose.Types.ObjectId(
                            entry.customerId
                        )
                        : undefined,

                supplierId:
                    entry.supplierId
                        ? new mongoose.Types.ObjectId(
                            entry.supplierId
                        )
                        : undefined,

                referenceId:
                    entry.referenceId
                        ? new mongoose.Types.ObjectId(
                            entry.referenceId
                        )
                        : undefined,

                description:
                    entry.description,

                entryDate:
                    entry.entryDate ??
                    new Date(),

                createdBy:
                    user.userId,
            })
        );

        // 10. Save using existing transaction session
        if (session) {
            return await LedgerEntry.create(documents, {
                session,
                ordered: true,
            });
        }

        // 11. Save normally if no transaction exists
        return await LedgerEntry.create(
            documents
        );
    }
}