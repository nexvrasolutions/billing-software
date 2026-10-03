import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongodb";

import { Tenant } from "@/lib/models/Tenant";
import { Permission } from "@/lib/models/Permission";
import { Role } from "@/lib/models/Role";
import { User } from "@/lib/models/User";

import { Category } from "@/lib/models/Category";
import { Unit } from "@/lib/models/Unit";
import { Product } from "@/lib/models/Product";

import { Customer } from "@/lib/models/Customer";
import { Supplier } from "@/lib/models/Supplier";

import { Purchase } from "@/lib/models/Purchase";
import { StockMovement } from "@/lib/models/StockMovement";

export async function GET() {
    try {
        await connectDB();

        /* =====================================================
           1. TENANT
        ===================================================== */

        const tenant = await Tenant.findOneAndUpdate(
            {
                name: "Test Business",
            },
            {
                name: "Test Business",
                businessType: "Retail",
                status: "active",
            },
            {
                new: true,
                upsert: true,
            }
        );

        /* =====================================================
           2. PERMISSION
        ===================================================== */

        const permission = await Permission.findOneAndUpdate(
            {
                name: "products.create",
            },
            {
                name: "products.create",
                description: "Create products",
            },
            {
                new: true,
                upsert: true,
            }
        );

        /* =====================================================
           3. ROLE
        ===================================================== */

        const role = await Role.findOneAndUpdate(
            {
                tenantId: tenant._id,
                name: "Admin",
            },
            {
                tenantId: tenant._id,
                name: "Admin",
                description: "Test administrator role",
                permissions: [permission._id],
                status: "active",
            },
            {
                new: true,
                upsert: true,
            }
        );

        /* =====================================================
           4. USER
        ===================================================== */

        const user = await User.findOneAndUpdate(
            {
                tenantId: tenant._id,
                email: "admin@testbusiness.com",
            },
            {
                tenantId: tenant._id,
                name: "Test Admin",
                email: "admin@testbusiness.com",

                // Test value only.
                // Real authentication will use a properly hashed password.
                passwordHash: "TEST_PASSWORD_HASH",

                roleId: role._id,
                status: "active",
            },
            {
                new: true,
                upsert: true,
            }
        );

        /* =====================================================
           5. CATEGORY
        ===================================================== */

        const category = await Category.findOneAndUpdate(
            {
                tenantId: tenant._id,
                name: "Grocery",
            },
            {
                tenantId: tenant._id,
                name: "Grocery",
                description: "Test grocery category",
                status: "active",
            },
            {
                new: true,
                upsert: true,
            }
        );

        /* =====================================================
           6. UNIT
        ===================================================== */

        const unit = await Unit.findOneAndUpdate(
            {
                tenantId: tenant._id,
                name: "Kilogram",
            },
            {
                tenantId: tenant._id,
                name: "Kilogram",
                shortName: "kg",
                status: "active",
            },
            {
                new: true,
                upsert: true,
            }
        );

        /* =====================================================
           7. PRODUCT
        ===================================================== */

        const product = await Product.findOneAndUpdate(
            {
                tenantId: tenant._id,
                SKU: "RICE-001",
            },
            {
                tenantId: tenant._id,
                name: "Basmati Rice",
                SKU: "RICE-001",
                barcode: "8901234567890",

                categoryId: category._id,
                unitId: unit._id,

                purchasePrice: 100,
                sellingPrice: 120,

                stockQuantity: 50,

                status: "active",
            },
            {
                new: true,
                upsert: true,
            }
        );

        /* =====================================================
           8. CUSTOMER
        ===================================================== */

        const customer = await Customer.findOneAndUpdate(
            {
                tenantId: tenant._id,
                phone: "9876543210",
            },
            {
                tenantId: tenant._id,
                name: "Test Customer",
                phone: "9876543210",
                email: "customer@test.com",
                address: "Nagercoil, Tamil Nadu",
                status: "active",
            },
            {
                new: true,
                upsert: true,
            }
        );

        /* =====================================================
           9. SUPPLIER
        ===================================================== */

        const supplier = await Supplier.findOneAndUpdate(
            {
                tenantId: tenant._id,
                supplierCode: "SUP-0001",
            },
            {
                tenantId: tenant._id,

                supplierCode: "SUP-0001",

                name: "ABC Traders",

                contact: {
                    contactPerson: "Ravi Kumar",
                    phone: "9876543211",
                    altPhone: "9876543212",
                    email: "ravi@abctraders.com",
                    website: "https://abctraders.com",
                },

                address: {
                    line1: "12 Market Road",
                    line2: "Near Main Market",
                    city: "Nagercoil",
                    state: "Tamil Nadu",
                    country: "India",
                    pincode: "629001",
                },

                tax: {
                    gstin: "33ABCDE1234F1Z5",
                    pan: "ABCDE1234F",
                    taxRegistrationType: "registered",
                },

                paymentTerms: {
                    type: "credit",
                    creditDays: 30,
                    dueDateCalculation: "invoiceDate",
                },

                creditLimit: 100000,

                currency: "INR",

                status: "active",

                isDeleted: false,

                createdBy: user._id,
            },
            {
                new: true,
                upsert: true,
            }
        );

        /* =====================================================
           10. PURCHASE
        ===================================================== */

        const purchase = await Purchase.findOneAndUpdate(
            {
                tenantId: tenant._id,
                purchaseNo: "PUR-TEST-001",
            },
            {
                tenantId: tenant._id,

                purchaseNo: "PUR-TEST-001",

                supplierId: supplier._id,

                supplierSnapshot: {
                    name: supplier.name,
                    supplierCode: supplier.supplierCode,
                    phone: supplier.contact?.phone,
                    gstin: supplier.tax?.gstin,
                },

                purchaseDate: new Date(),

                supplierInvoiceNo: "INV-ABC-001",
                supplierInvoiceDate: new Date(),

                warehouse: {
                    name: "Main Warehouse",
                    location: "Nagercoil",
                },

                items: [
                    {
                        productId: product._id,

                        productSnapshot: {
                            name: product.name,
                            SKU: product.SKU,
                            unit: unit.shortName || unit.name,
                        },

                        quantity: 20,

                        unitPrice: 100,

                        discountRate: 0,
                        discountAmount: 0,

                        tax: {
                            rate: 5,
                            amount: 100,
                        },

                        total: 2100,
                    },
                ],

                subtotal: 2000,
                discountTotal: 0,
                taxTotal: 100,

                shippingCost: 0,

                grandTotal: 2100,

                paidAmount: 1000,
                dueAmount: 1100,

                paymentStatus: "partial",

                status: "received",

                notes: "Test purchase",

                createdBy: user._id,
            },
            {
                new: true,
                upsert: true,
            }
        );

        /* =====================================================
           11. STOCK MOVEMENT
        ===================================================== */

        const stockMovement = await StockMovement.findOneAndUpdate(
            {
                tenantId: tenant._id,
                productId: product._id,
                referenceId: purchase._id,
                type: "purchase",
            },
            {
                tenantId: tenant._id,

                productId: product._id,

                type: "purchase",

                quantity: 20,

                referenceId: purchase._id,

                previousStock: 50,

                newStock: 70,

                warehouse: {
                    name: "Main Warehouse",
                    location: "Nagercoil",
                },

                reason: "Test purchase stock movement",

                createdBy: user._id,
            },
            {
                new: true,
                upsert: true,
            }
        );

        /* =====================================================
           SUCCESS RESPONSE
        ===================================================== */

        return NextResponse.json({
            success: true,

            message: "All test data created successfully",

            data: {
                tenant,
                permission,
                role,
                user,
                category,
                unit,
                product,
                customer,
                supplier,
                purchase,
                stockMovement,
            },
        });
    } catch (error) {
        console.error("Test database error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Test database failed",
                error:
                    error instanceof Error
                        ? error.message
                        : String(error),
            },
            {
                status: 500,
            }
        );
    }
}