import dns from "dns";
import mongoose from "mongoose";

// Use public DNS resolvers to avoid local DNS/SRV resolution problems
function setupDns() {
    try {
        dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
    } catch {
        // Ignore DNS setup errors
    }
}

setupDns();

interface MongooseCache {
    uri: string;
    conn: typeof mongoose | null;
    promise: Promise<typeof mongoose> | null;
}

declare global {
    // eslint-disable-next-line no-var
    var _mongooseCache: MongooseCache | undefined;
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

    try {
        cached.conn = await cached.promise;
    } catch (error) {
        cached.promise = null;
        throw error;
    }

    return cached.conn;
}