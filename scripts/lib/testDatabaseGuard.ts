
/*
 * Shared database-name guard for database-backed test scripts.
 *
 * Same rule as the inline guards in scripts/test-offline-sync.ts and
 * scripts/test-offline-sync-browser.ts: a test may only run against the
 * database named exactly "billing_test". Call it at the start of main(),
 * BEFORE connectDB(), runTestSafely() or anything else that can connect.
 *
 * Fails closed: a missing, unparseable or unnamed URI is refused too.
 * Neither the URI, the credentials nor the database name found in it ever
 * appear in a message. Run tests with NODE_ENV=test so that only
 * .env.test.local is loaded (never .env.local, the main database).
 *
 * This module imports nothing and connects to nothing.
 */

/** The only database the test scripts may use. */
export const TEST_DATABASE_NAME = "billing_test";

export function assertTestDatabaseUri(uri: string | undefined): void {
    const refuse = (): never => {
        throw new Error(
            `Refusing to run: MONGODB_URI must name the dedicated test database ${TEST_DATABASE_NAME}. ` +
            "Nothing was connected to or written."
        );
    };

    if (!uri) return refuse();

    // The name is the first path segment of a mongodb:// or mongodb+srv://
    // URI (reserved characters in credentials must be percent-encoded, as
    // MongoDB requires; anything else fails to parse and is refused).
    const match = /^mongodb(?:\+srv)?:\/\/([^/?#]+)\/([^/?#]*)/i.exec(uri.trim());
    if (!match) return refuse();

    let name: string;
    try {
        name = decodeURIComponent(match[2]);
    } catch {
        return refuse();
    }

    // Exactly the test database: not another "*_test" database, not a
    // name that merely contains it.
    if (name !== TEST_DATABASE_NAME) return refuse();
}
