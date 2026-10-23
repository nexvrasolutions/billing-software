import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db/mongodb";
import { Category } from "@/lib/models/Category";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      return NextResponse.json({ success: false, message: "Authentication required" }, { status: 401 });
    }

    await connectDB();
    const tenantId = new mongoose.Types.ObjectId(auth.tenantId);
    let categories = await Category.find({ tenantId }).sort({ name: 1 }).lean();

    // Seed default if empty
    if (categories.length === 0) {
      const defaultCat = await Category.create({
        tenantId,
        name: "General",
        description: "Default Category",
        status: "active",
      });
      categories = [defaultCat.toObject()];
    }

    return NextResponse.json({ success: true, categories });
  } catch (error) {
    console.error("GET CATEGORIES ERROR:", error);
    return NextResponse.json({ success: false, message: "Failed to list categories" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      return NextResponse.json({ success: false, message: "Authentication required" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) {
      return NextResponse.json({ success: false, message: "Category name is required" }, { status: 400 });
    }

    await connectDB();
    const category = await Category.create({
      tenantId: new mongoose.Types.ObjectId(auth.tenantId),
      name,
      description: String(body.description || "").trim(),
      status: "active",
    });

    return NextResponse.json({ success: true, category }, { status: 201 });
  } catch (error) {
    console.error("CREATE CATEGORY ERROR:", error);
    return NextResponse.json({ success: false, message: "Failed to create category" }, { status: 500 });
  }
}
