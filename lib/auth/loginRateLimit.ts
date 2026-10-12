
import { createHmac } from "crypto";
import { isIP } from "net";
import { NextRequest } from "next/server";
import mongoose from "mongoose";

import { LoginRateLimit } from "@/lib/models/LoginRateLimit";

/*
 * Login rate limiting backed by MongoDB (shared by all app instances and
 * persistent across restarts).
 *
 * Three independent limits count FAILED logins:
 *   - per IP              : stops one machine spraying many accounts
 *   - per account + IP    : stops one machine guessing one password
 *   - per account (any IP): stops distributed guessing of one password
 *
 * The account+IP limit is the strict one. The account-wide limit is much
 * higher, so an attacker cannot cheaply lock a real user out from a single
 * address; any lockout is temporary and capped (progressive: base, 2x, 4x,
 * ... up to the maximum).
 *
 * If the store cannot be reached, callers must refuse the login (fail
 * closed); see RateLimitUnavailableError.
 */

function intFromEnv(name: string, fallback: number, min: number): number {
    const value = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(value) && value >= min ? value : fallback;
}

/** Read lazily so the values can be changed through environment variables. */
export function getLoginRateLimitConfig() {
    return {
        windowSeconds: intFromEnv("LOGIN_RATE_LIMIT_WINDOW_SECONDS", 15 * 60, 1),
        ipMax: intFromEnv("LOGIN_RATE_LIMIT_IP_MAX", 30, 1),
        accountIpMax: intFromEnv("LOGIN_RATE_LIMIT_ACCOUNT_IP_MAX", 5, 1),
        accountMax: intFromEnv("LOGIN_RATE_LIMIT_ACCOUNT_MAX", 25, 1),
        lockoutBaseSeconds: intFromEnv("LOGIN_LOCKOUT_BASE_SECONDS", 60, 1),
        lockoutMaxSeconds: intFromEnv("LOGIN_LOCKOUT_MAX_SECONDS", 15 * 60, 1),
    };
}

// Lockout level is remembered this long, for progressive lockouts.
const LOCKOUT_MEMORY_MS = 24 * 60 * 60 * 1000;

export class RateLimitUnavailableError extends Error {
    constructor() {
        super("Login rate limit store unavailable");
        this.name = "RateLimitUnavailableError";
    }
}

let warnedMissingIpHeader = false;

/**
 * The client IP, taken ONLY from the header named in LOGIN_TRUSTED_IP_HEADER.
 * That header must be set (overwritten or appended) by your own hosting
 * proxy. Clients can send any header they like, so without this setting
 * no header is trusted and IP-based limits are skipped (account limits
 * still apply). For comma-separated lists the rightmost entry is used,
 * because that is the one added by the nearest trusted proxy.
 */
export function getClientIp(request: NextRequest): string | null {
    const headerName = process.env.LOGIN_TRUSTED_IP_HEADER?.trim().toLowerCase();

    if (!headerName) {
        if (process.env.NODE_ENV === "production" && !warnedMissingIpHeader) {
            warnedMissingIpHeader = true;
            console.warn(
                "LOGIN_TRUSTED_IP_HEADER is not set: IP-based login limits are disabled; account limits still apply."
            );
        }
        return null;
    }

    const raw = request.headers.get(headerName);
    const candidate = raw
        ?.split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .pop();

    return candidate && isIP(candidate) ? candidate.toLowerCase() : null;
}

export interface LoginAttemptSubject {
    ip: string | null;
    /** Normalized (trimmed, lowercased) email. */
    email: string;
}

interface Bucket {
    key: string;
    max: number;
}

/** HMAC so raw IPs/emails are never stored in the rate-limit collection. */
function bucketKey(kind: string, value: string): string {
    const secret = process.env.SESSION_SECRET;

    if (!secret) {
        throw new RateLimitUnavailableError();
    }

    return createHmac("sha256", `login-rate-limit:${secret}`)
        .update(`${kind}:${value}`)
        .digest("hex");
}

export function getLoginBuckets(subject: LoginAttemptSubject): Bucket[] {
    const config = getLoginRateLimitConfig();
    const buckets: Bucket[] = [
        {
            key: bucketKey("account-ip", `${subject.email}|${subject.ip ?? "unknown"}`),
            max: config.accountIpMax,
        },
        { key: bucketKey("account", subject.email), max: config.accountMax },
    ];

    if (subject.ip) {
        buckets.push({ key: bucketKey("ip", subject.ip), max: config.ipMax });
    }

    return buckets;
}

async function withStore<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof RateLimitUnavailableError) {
            throw error;
        }

        console.error(
            "Login rate limit store error:",
            error instanceof Error ? error.name : "unknown"
        );
        throw new RateLimitUnavailableError();
    }
}

/**
 * Check BEFORE any password hashing. Returns the number of seconds to wait
 * when any bucket is locked.
 */
export async function checkLoginRateLimit(
    subject: LoginAttemptSubject
): Promise<{ limited: false } | { limited: true; retryAfterSeconds: number }> {
    return withStore(async () => {
        const now = new Date();
        const locked = await LoginRateLimit.find({
            key: { $in: getLoginBuckets(subject).map((bucket) => bucket.key) },
            lockedUntil: { $gt: now },
        })
            .select("lockedUntil")
            .lean();

        if (!locked.length) {
            return { limited: false };
        }

        const until = Math.max(
            ...locked.map((bucket) => bucket.lockedUntil!.getTime())
        );

        return {
            limited: true,
            retryAfterSeconds: Math.max(1, Math.ceil((until - now.getTime()) / 1000)),
        };
    });
}

async function incrementBucket(bucket: Bucket, now: Date) {
    const config = getLoginRateLimitConfig();
    const windowStartCutoff = new Date(now.getTime() - config.windowSeconds * 1000);
    const idleExpiry = new Date(now.getTime() + config.windowSeconds * 1000 + LOCKOUT_MEMORY_MS);

    // Start a fresh counting window if the previous one has ended.
    await LoginRateLimit.updateOne(
        { key: bucket.key, windowStart: { $lt: windowStartCutoff } },
        { $set: { failures: 0, windowStart: now } }
    );

    const increment = () =>
        LoginRateLimit.findOneAndUpdate(
            { key: bucket.key },
            {
                $inc: { failures: 1 },
                $setOnInsert: { windowStart: now, lockoutLevel: 0 },
                $max: { expiresAt: idleExpiry },
            },
            { upsert: true, returnDocument: "after" }
        ).lean();

    let doc;

    try {
        doc = await increment();
    } catch (error) {
        // Two first-time failures raced to create the same counter.
        if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
            doc = await increment();
        } else {
            throw error;
        }
    }

    if (!doc || doc.failures < bucket.max) {
        return;
    }

    // Limit reached: lock, with a progressively longer lockout for repeat
    // offences within LOCKOUT_MEMORY_MS.
    const recentlyLocked =
        doc.lastLockedAt && now.getTime() - doc.lastLockedAt.getTime() < LOCKOUT_MEMORY_MS;
    const level = recentlyLocked ? doc.lockoutLevel : 0;
    const lockSeconds = Math.min(
        config.lockoutBaseSeconds * 2 ** level,
        config.lockoutMaxSeconds
    );
    const lockedUntil = new Date(now.getTime() + lockSeconds * 1000);

    // Conditional on failures so concurrent requests lock only once.
    await LoginRateLimit.updateOne(
        { key: bucket.key, failures: { $gte: bucket.max } },
        {
            $set: {
                failures: 0,
                windowStart: now,
                lockedUntil,
                lastLockedAt: now,
                lockoutLevel: level + 1,
                expiresAt: new Date(lockedUntil.getTime() + LOCKOUT_MEMORY_MS),
            },
        }
    );
}

/** Record one failed login against every applicable bucket. */
export async function recordLoginFailure(subject: LoginAttemptSubject): Promise<void> {
    await withStore(async () => {
        const now = new Date();
        await Promise.all(
            getLoginBuckets(subject).map((bucket) => incrementBucket(bucket, now))
        );
    });
}

/**
 * After a successful login, clear the ACCOUNT counters for this account.
 * The IP counter is deliberately kept, so an attacker who owns one valid
 * account cannot use it to reset the IP limit while attacking others.
 */
export async function clearAccountLoginFailures(subject: LoginAttemptSubject): Promise<void> {
    await withStore(async () => {
        const [accountIp, account] = getLoginBuckets(subject);
        await LoginRateLimit.deleteMany({
            key: { $in: [accountIp.key, account.key] },
            $or: [
                { lockedUntil: { $exists: false } },
                { lockedUntil: { $lte: new Date() } },
            ],
        });
    });
}
