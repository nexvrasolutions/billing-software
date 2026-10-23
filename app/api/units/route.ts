import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db/mongodb";
import { Unit } from "@/lib/models/Unit";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { getGrantedPermissions } from "@/lib/auth/hasPermission";

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      return NextResponse.json({ success: false, message: "Authentication required" }, { status: 401 });
    }

    await connectDB();
    const tenantId = new mongoose.Types.ObjectId(auth.tenantId);
    let units = await Unit.find({ tenantId }).sort({ name: 1 }).lean();

    // Seed default if empty
    if (units.length === 0) {
      const defaultUnit = await Unit.create({
        tenantId,
        name: "Pieces",
        shortName: "pcs",
        status: "active",
      });
      units = [defaultUnit.toObject()];
    }

    return NextResponse.json({ success: true, units });
  } catch (error) {
    console.error("GET UNITS ERROR:", error);
    return NextResponse.json({ success: false, message: "Failed to list units" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      return NextResponse.json({ success: false, message: "Authentication required" }, { status: 401 });
    }

    if (!auth.roleId) {
      return NextResponse.json({ success: false, message: "Permission denied" }, { status: 403 });
    }

    const granted = await getGrantedPermissions({
      userId: auth.userId,
      tenantId: auth.tenantId,
      roleId: auth.roleId,
      permissions: ["products.create", "units.create"],
    });

    if (granted.size === 0) {
      return NextResponse.json(
        { success: false, message: "You do not have permission to create units" },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const shortName = String(body.shortName || body.code || "pcs").trim();
    if (!name) {
      return NextResponse.json({ success: false, message: "Unit name is required" }, { status: 400 });
    }

    await connectDB();
    const unit = await Unit.create({
      tenantId: new mongoose.Types.ObjectId(auth.tenantId),
      name,
      shortName,
      status: "active",
    });

    return NextResponse.json({ success: true, unit }, { status: 201 });
  } catch (error) {
    console.error("CREATE UNIT ERROR:", error);
    return NextResponse.json({ success: false, message: "Failed to create unit" }, { status: 500 });
  }
}
