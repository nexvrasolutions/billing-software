
// import "dotenv/config";
// import mongoose from "mongoose";
// import { connectDB } from "../lib/db/mongodb";
// import { User } from "../lib/models/User";
// import { Role } from "../lib/models/Role";
// import { Permission } from "../lib/models/Permission";
// import dotenv from "dotenv";
// dotenv.config({ path: ".env.local" });

// const TENANT_ID = "6abe48a86ae4b08a3e335303";
// const TEST_USER_ID = "6ac9c048bc8d48ae104a7151";
// const ADMIN_USER_ID = "6abe4d3f6ae4b08a3e335463";

// async function main() {
//     if (process.env.NODE_ENV === "production") {
//         throw new Error("Refusing to run in production.");
//     }

//     if (process.env.ALLOW_ADMIN_PROTECTION_TEST !== "YES") {
//         throw new Error(
//             "Set ALLOW_ADMIN_PROTECTION_TEST=YES after confirming this is a development database."
//         );
//     }

//     await connectDB();

//     const tenantId = new mongoose.Types.ObjectId(TENANT_ID);

//     const [admin, testUser, updatePermission] = await Promise.all([
//         User.findOne({
//             _id: ADMIN_USER_ID,
//             tenantId,
//             status: "active",
//         }),
//         User.findOne({
//             _id: TEST_USER_ID,
//             tenantId,
//             status: "active",
//         }),
//         Permission.findOne({ name: "users.update" }),
//     ]);

//     if (!admin || !testUser || !updatePermission) {
//         throw new Error(
//             "Admin, test user, or users.update permission was not found. No role changes were made."
//         );
//     }

//     const adminRole = await Role.findOne({
//         _id: admin.roleId,
//         tenantId,
//         status: "active",
//     });

//     if (!adminRole) {
//         throw new Error("Original Admin role was not found.");
//     }

//     const adminPermissionNames = await Permission.find({
//         _id: { $in: adminRole.permissions },
//     }).distinct("name");

//     const requiredAdminPermissions = [
//         "users.create",
//         "users.update",
//         "users.delete",
//     ];

//     if (
//         !requiredAdminPermissions.every((name) =>
//             adminPermissionNames.includes(name)
//         )
//     ) {
//         throw new Error(
//             "Original Admin role does not have all expected permissions. Stopping."
//         );
//     }

//     const roleName = "Admin Protection Test";
//     let testRole = await Role.findOne({ tenantId, name: roleName });

//     if (!testRole) {
//         testRole = await Role.create({
//             tenantId,
//             name: roleName,
//             description:
//                 "Temporary development role for testing last-admin protection",
//             permissions: [updatePermission._id],
//             status: "active",
//         });
//     } else {
//         const existingPermissionNames = await Permission.find({
//             _id: { $in: testRole.permissions },
//         }).distinct("name");

//         if (
//             existingPermissionNames.length !== 1 ||
//             existingPermissionNames[0] !== "users.update"
//         ) {
//             throw new Error(
//                 "The existing test role has unexpected permissions. It was not changed."
//             );
//         }
//     }

//     // Assign only the test user to the non-admin test role.
//     testUser.roleId = testRole._id;
//     await testUser.save();

//     console.log("Test setup completed.");
//     console.log("Original Admin remains active and unchanged.");
//     console.log("Test role:", testRole.name);
//     console.log("Test user:", testUser.email);
//     console.log("Test role permissions: users.update only");
// }

// main()
//     .catch((error: unknown) => {
//         console.error(
//             "Test setup failed:",
//             error instanceof Error ? error.message : "Unknown error"
//         );
//         process.exitCode = 1;
//     })
//     .finally(async () => {
//         await mongoose.disconnect();
//     });
