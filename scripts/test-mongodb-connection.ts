
/*
 * Tests for lib/db/mongodb.ts (connection helper).
 *
 * Each scenario runs in a fresh child process (the DNS setup is applied
 * once per process). mongoose.connect is stubbed except in the "live"
 * scenario, which only opens and closes a connection (no reads/writes).
 * Never prints the connection string or other secrets.
 *
 * Run:
 *   npx tsx scripts/test-mongodb-connection.ts
 */

import { loadEnvConfig } from "@next/env";
import { spawnSync } from "child_process";
import path from "path";

loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

const SCENARIOS = [
    "reuse",
    "retry",
    "dns-default",
    "dns-system",
    "dns-custom",
    "missing-uri",
    "live",
] as const;

type Scenario = (typeof SCENARIOS)[number];

async function runScenario(name: Scenario): Promise<[boolean, string]> {
    const mongoose = (await import("mongoose")).default;
    // The default export is the live CommonJS module. The ESM namespace's
    // named exports are stale after setServers() rebinds them.
    const dns = (await import("dns")).default;
    const { connectDB } = await import("../lib/db/mongodb");

    const originalConnect = mongoose.connect.bind(mongoose);
    let connectCalls = 0;

    // Stub: resolves with mongoose without any network access.
    const stubConnect = (fail = false) => {
        mongoose.connect = (async () => {
            connectCalls++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (fail && connectCalls === 1) {
                throw Object.assign(new Error("simulated"), { code: "ECONNREFUSED" });
            }
            return mongoose;
        }) as typeof mongoose.connect;
    };

    switch (name) {
        case "reuse": {
            stubConnect();
            const results = await Promise.all(Array.from({ length: 5 }, () => connectDB()));
            return [
                connectCalls === 1 && results.every((r) => r === mongoose),
                `5 concurrent calls -> ${connectCalls} connect attempt(s)`,
            ];
        }
        case "retry": {
            stubConnect(true);
            const first = await Promise.allSettled([connectDB(), connectDB()]);
            const bothFailed = first.every((r) => r.status === "rejected");
            const promiseCleared = global._mongooseCache?.promise === null;
            const second = await connectDB().then(() => true, () => false);
            return [
                bothFailed && promiseCleared && second && connectCalls === 2,
                `first attempt rejected for both callers=${bothFailed}, cached promise cleared=${promiseCleared}, retry succeeded=${second}, attempts=${connectCalls}`,
            ];
        }
        case "dns-default":
        case "dns-system":
        case "dns-custom": {
            stubConnect();
            const before = dns.promises.getServers().join(",");
            await connectDB();
            await connectDB();
            const callback = dns.getServers().join(",");
            const promises = dns.promises.getServers().join(",");
            const expected =
                name === "dns-default" ? "8.8.8.8,1.1.1.1,8.8.4.4"
                    : name === "dns-custom" ? "1.1.1.1,9.9.9.9"
                        : before;
            return [
                callback === expected && promises === expected,
                `callback resolver=${callback} promises resolver=${promises} expected=${expected}`,
            ];
        }
        case "missing-uri": {
            delete process.env.MONGODB_URI;
            stubConnect();
            const message = await connectDB().then(() => "connected", (e: Error) => e.message);
            return [
                message === "MONGODB_URI environment variable is not defined" && connectCalls === 0,
                `error="${message}" attempts=${connectCalls}`,
            ];
        }
        case "live": {
            mongoose.connect = originalConnect;
            const started = Date.now();
            await connectDB();
            const state = mongoose.connection.readyState;
            await mongoose.disconnect();
            return [state === 1, `real Atlas connection readyState=${state} in ${Date.now() - started}ms`];
        }
    }
}

async function main() {
    const child = process.argv.indexOf("--scenario");

    if (child >= 0) {
        const name = process.argv[child + 1] as Scenario;
        const [passed, detail] = await runScenario(name).catch(
            (e: unknown) => [false, `threw ${(e as { code?: string })?.code ?? (e as Error)?.name}`] as [boolean, string]
        );
        console.log(`RESULT ${passed ? "PASS" : "FAIL"} ${detail}`);
        process.exit(0);
    }

    let failed = 0;

    for (const name of SCENARIOS) {
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.MONGODB_DNS_SERVERS;
        if (name === "dns-system") env.MONGODB_DNS_SERVERS = "system";
        if (name === "dns-custom") env.MONGODB_DNS_SERVERS = "1.1.1.1, 9.9.9.9";

        const result = spawnSync(
            process.execPath,
            [path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), process.argv[1], "--scenario", name],
            { env, encoding: "utf8", timeout: 120000 }
        );
        const line = /RESULT (PASS|FAIL) (.*)/.exec(result.stdout ?? "");
        const passed = line?.[1] === "PASS";
        if (!passed) failed++;
        console.log(`${passed ? "PASS" : "FAIL"}  ${name}: ${line?.[2] ?? `no result (exit ${result.status})`}`);
    }

    console.log(`\n${SCENARIOS.length - failed}/${SCENARIOS.length} scenarios passed.`);
    if (failed) process.exitCode = 1;
}

main();
