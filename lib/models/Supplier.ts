import mongoose, { Schema, Document, Model } from "mongoose";

export interface ISupplier extends Document {
    tenantId: mongoose.Types.ObjectId;

    supplierCode: string;
    name: string;

    contact: {
        contactPerson?: string;
        phone?: string;
        altPhone?: string;
        email?: string;
        website?: string;
    };

    address: {
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        country?: string;
        pincode?: string;
    };

    shippingAddress?: {
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        country?: string;
        pincode?: string;
    };

    tax: {
        gstin?: string;
        pan?: string;
        taxRegistrationType:
        | "registered"
        | "unregistered"
        | "composition"
        | "overseas";
    };

    paymentTerms: {
        type: "cash" | "credit";
        creditDays: number;
        dueDateCalculation: "invoiceDate" | "receiptDate";
    };

    creditLimit: number;

    currency: string;

    bankDetails?: {
        accountName?: string;
        accountNumber?: string;
        bankName?: string;
        ifsc?: string;
        upiId?: string;
    };

    category?: string;

    notes?: string;

    tags: string[];

    customFields: Record<string, unknown>;

    status: "active" | "inactive" | "blocked";

    isDeleted: boolean;

    createdBy?: mongoose.Types.ObjectId;

    createdAt: Date;
    updatedAt: Date;
}

const SupplierSchema = new Schema<ISupplier>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },

        supplierCode: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
        },

        name: {
            type: String,
            required: true,
            trim: true,
        },

        contact: {
            contactPerson: {
                type: String,
                trim: true,
            },

            phone: {
                type: String,
                trim: true,
            },

            altPhone: {
                type: String,
                trim: true,
            },

            email: {
                type: String,
                trim: true,
                lowercase: true,
            },

            website: {
                type: String,
                trim: true,
            },
        },

        address: {
            line1: {
                type: String,
                trim: true,
            },

            line2: {
                type: String,
                trim: true,
            },

            city: {
                type: String,
                trim: true,
            },

            state: {
                type: String,
                trim: true,
            },

            country: {
                type: String,
                trim: true,
                default: "India",
            },

            pincode: {
                type: String,
                trim: true,
            },
        },

        shippingAddress: {
            line1: {
                type: String,
                trim: true,
            },

            line2: {
                type: String,
                trim: true,
            },

            city: {
                type: String,
                trim: true,
            },

            state: {
                type: String,
                trim: true,
            },

            country: {
                type: String,
                trim: true,
                default: "India",
            },

            pincode: {
                type: String,
                trim: true,
            },
        },

        tax: {
            gstin: {
                type: String,
                trim: true,
                uppercase: true,
            },

            pan: {
                type: String,
                trim: true,
                uppercase: true,
            },

            taxRegistrationType: {
                type: String,
                enum: [
                    "registered",
                    "unregistered",
                    "composition",
                    "overseas",
                ],
                default: "registered",
            },
        },

        paymentTerms: {
            type: {
                type: String,
                enum: ["cash", "credit"],
                default: "cash",
            },

            creditDays: {
                type: Number,
                min: 0,
                default: 0,
            },

            dueDateCalculation: {
                type: String,
                enum: ["invoiceDate", "receiptDate"],
                default: "invoiceDate",
            },
        },

        creditLimit: {
            type: Number,
            min: 0,
            default: 0,
        },

        currency: {
            type: String,
            trim: true,
            uppercase: true,
            default: "INR",
            minlength: 3,
            maxlength: 3,
        },

        bankDetails: {
            accountName: {
                type: String,
                trim: true,
            },

            accountNumber: {
                type: String,
                trim: true,
            },

            bankName: {
                type: String,
                trim: true,
            },

            ifsc: {
                type: String,
                trim: true,
                uppercase: true,
            },

            upiId: {
                type: String,
                trim: true,
            },
        },

        category: {
            type: String,
            trim: true,
        },

        notes: {
            type: String,
            trim: true,
        },

        tags: {
            type: [String],
            default: [],
        },

        customFields: {
            type: Schema.Types.Mixed,
            default: {},
        },

        status: {
            type: String,
            enum: ["active", "inactive", "blocked"],
            default: "active",
        },

        isDeleted: {
            type: Boolean,
            default: false,
            index: true,
        },

        createdBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
        },
    },
    {
        timestamps: true,
    }
);


/*
 * Supplier code must be unique
 * inside each tenant.
 */
SupplierSchema.index(
    {
        tenantId: 1,
        supplierCode: 1,
    },
    {
        unique: true,
    }
);


/*
 * Useful for searching suppliers
 * by name inside a tenant.
 */
SupplierSchema.index({
    tenantId: 1,
    name: 1,
});


/*
 * Useful for searching suppliers
 * by phone inside a tenant.
 */
SupplierSchema.index({
    tenantId: 1,
    "contact.phone": 1,
});


/*
 * Useful when filtering
 * active/non-deleted suppliers.
 */
SupplierSchema.index({
    tenantId: 1,
    isDeleted: 1,
    status: 1,
});


/*
 * Supplier model.
 *
 * Prevents model recompilation
 * during Next.js hot reload.
 */
export const Supplier: Model<ISupplier> =
    mongoose.models.Supplier ||
    mongoose.model<ISupplier>("Supplier", SupplierSchema);