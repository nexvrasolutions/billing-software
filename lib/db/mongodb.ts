import dns from "dns";
import mongoose from "mongoose";

/*
 * DNS servers used to resolve "mongodb+srv://" connection strings.
 *
 * Some networks' default resolver cannot answer the SRV/TXT lookups that
 * mongodb+srv needs, so public resolvers are used by default.
 * MONGODB_DNS_SERVERS overrides this:
 *   - "system"                 -> use the machine's normal DNS (no override)
 *   - "8.8.8.8,1.1.1.1"        -> use these servers
 *   - unset                    -> the public defaults below
 */
const DEFAULT_DNS_SERVERS = ["8.8.8.8", "1.1.1.1", "8.8.4.4"];

function setupDns() {
    // Apply only once per process: Node must not change DNS servers while
    // lookups are in flight (the driver keeps polling SRV records).
    // The flag lives on globalThis because the production build bundles
    // this module separately into each route.
    if (global._mongoDnsConfigured) {
        return;
    }

    global._mongoDnsConfigured = true;

    const setting = process.env.MONGODB_DNS_SERVERS?.trim();

    if (setting?.toLowerCase() === "system") {
        return;
    }

    const servers = setting
        ? setting.split(",").map((server) => server.trim()).filter(Boolean)
        : DEFAULT_DNS_SERVERS;

    try {
        // The MongoDB driver resolves SRV/TXT through dns.promises. In the
        // Next.js server, dns.setServers() alone did not reach that resolver
        // for the first lookup, so set the promise API explicitly too.
        dns.setServers(servers);
        dns.promises.setServers(servers);
    } catch (error) {
        // Not fatal: the system resolver is used. Report it instead of
        // failing silently (no secrets: only the error code).
        console.error(
            "MongoDB DNS server setup failed; using system DNS:",
            (error as { code?: unknown })?.code ?? "unknown"
        );
    }
}

interface MongooseCache {
    uri: string;
    conn: typeof mongoose | null;
    promise: Promise<typeof mongoose> | null;
}

declare global {
    var _mongooseCache: MongooseCache | undefined;
    var _mongoDnsConfigured: boolean | undefined;
}

export async function connectDB(): Promise<typeof mongoose> {
    setupDns();

    const MONGODB_URI = process.env.MONGODB_URI;

    if (!MONGODB_URI) {
        throw new Error("MONGODB_URI environment variable is not defined");
    }

    // Reset cache if the connection URI changed
    if (
        global._mongooseCache &&
        global._mongooseCache.uri !== MONGODB_URI
    ) {
        try {
            await mongoose.disconnect();
        } catch {
            // Ignore disconnect errors
        }

        global._mongooseCache = undefined;
    }

    // Already connected
    if (mongoose.connection.readyState === 1) {
        return mongoose;
    }

    // Create cache
    if (!global._mongooseCache) {
        global._mongooseCache = {
            uri: MONGODB_URI,
            conn: null,
            promise: null,
        };
    }

    const cached = global._mongooseCache;

    // Existing connection
    if (cached.conn) {
        return cached.conn;
    }

    // Existing connection attempt
    if (!cached.promise) {
        cached.promise = mongoose.connect(MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 15000,
            connectTimeoutMS: 15000,
            socketTimeoutMS: 30000,
        });
    }

    const attempt = cached.promise;

    try {
        cached.conn = await attempt;
    } catch (error) {
        // Allow a later call to retry, but only clear THIS failed attempt:
        // a newer attempt started by another request must not be dropped.
        if (cached.promise === attempt) {
            cached.promise = null;
        }

        throw error;
    }

    return cached.conn;
}

/**
 * Detect whether an error is caused by database connectivity/DNS failure
 * (e.g. MongoDB Atlas unreachable when offline, server selection timeout, network down).
 */
export function isDatabaseConnectionError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const err = error as { name?: string; message?: string; code?: string };
    const name = err.name || "";
    const msg = err.message || "";
    const code = err.code || "";

    return (
        name === "MongoServerSelectionError" ||
        name === "MongooseServerSelectionError" ||
        name === "MongoNetworkError" ||
        name === "MongoTimeoutError" ||
        name === "MongoNotConnectedError" ||
        name === "MongoTopologyClosedError" ||
        code === "ENOTFOUND" ||
        code === "ETIMEDOUT" ||
        code === "ECONNREFUSED" ||
        msg.includes("ENOTFOUND") ||
        msg.includes("Server selection timed out") ||
        msg.includes("buffering timed out")
    );
}