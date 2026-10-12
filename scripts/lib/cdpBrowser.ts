/*
 * Minimal Chrome DevTools Protocol driver for browser tests (no extra
 * dependencies). Every command and wait is time-bounded.
 */

import { existsSync } from "fs";

export const BASE_URL = process.env.BASE_URL ?? "http://localhost:3130";

export function findBrowser(): string {
    const candidates = [
        process.env.BROWSER_PATH,
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
    ].filter(Boolean) as string[];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) throw new Error("No Chrome/Edge found; set BROWSER_PATH.");
    return found;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Every DevTools command must answer within this time.
const CDP_COMMAND_TIMEOUT_MS = 30_000;

/** Minimal Chrome DevTools Protocol client for one page. */
export class Page {
    private nextId = 1;
    private pending = new Map<number, (value: { result?: unknown; error?: { message: string } }) => void>();

    private constructor(private socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            if (message.id && this.pending.has(message.id)) {
                this.pending.get(message.id)!(message);
                this.pending.delete(message.id);
            }
        });
    }

    static async connect(port: number): Promise<Page> {
        for (let i = 0; i < 50; i++) {
            try {
                const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
                const target = targets.find((t) => t.type === "page");
                if (target) {
                    const socket = new WebSocket(target.webSocketDebuggerUrl);
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(new Error("Browser connection did not open within 10s")), 10_000);
                        socket.addEventListener("open", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
                        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Browser connection failed")); }, { once: true });
                    });
                    const page = new Page(socket);
                    await page.send("Page.enable");
                    await page.send("Runtime.enable");
                    // Auto-accept window.confirm() dialogs on every page.
                    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.confirm = () => true;" });
                    return page;
                }
            } catch { /* browser still starting */ }
            await sleep(200);
        }
        throw new Error("Could not connect to the browser.");
    }

    send(method: string, params: Record<string, unknown> = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<unknown> {
        const id = this.nextId++;
        this.socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => {
            // A browser command must answer in time; otherwise fail clearly
            // instead of waiting forever. (Browser commands do not write to
            // the database; the browser is killed during cleanup anyway.)
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Browser command ${method} timed out after ${timeoutMs / 1000}s`));
            }, timeoutMs);
            this.pending.set(id, (message) => {
                clearTimeout(timer);
                if (message.error) reject(new Error(message.error.message));
                else resolve(message.result);
            });
        });
    }

    async eval<T>(expression: string): Promise<T> {
        const result = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
            result: { value: T };
            exceptionDetails?: { text: string };
        };
        if (result.exceptionDetails) throw new Error(`Page script error: ${result.exceptionDetails.text}`);
        return result.result.value;
    }

    async goto(urlPath: string) {
        await this.send("Page.navigate", { url: `${BASE_URL}${urlPath}` });
        await this.waitFor("document.readyState === 'complete'");
    }

    async waitFor(condition: string, timeoutMs = 15000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                // Await first, so promise-based conditions are evaluated
                // (Boolean(promise) would always be true).
                if (await this.eval<boolean>(`Promise.resolve(${condition}).then(Boolean)`)) return true;
            } catch { /* page navigating */ }
            await sleep(100);
        }
        return false;
    }

    waitForText(text: string, timeoutMs = 15000) {
        return this.waitFor(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`, timeoutMs);
    }

    text(): Promise<string> {
        return this.eval<string>("document.body.innerText");
    }

    /** Set a React-controlled input/select value the way a user would. */
    async fill(selector: string, value: string) {
        await this.eval(`(() => {
            const el = ${selector};
            if (!el) throw new Error("element not found");
            const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
            el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
        })()`);
    }

    /** Click the first button (optionally inside a scope) whose text matches. */
    async clickButton(label: string, scope = "document") {
        const clicked = await this.eval<boolean>(`(() => {
            const button = [...(${scope}).querySelectorAll("button")].find((b) => b.innerText.trim() === ${JSON.stringify(label)} && !b.disabled);
            if (!button) return false;
            button.click();
            return true;
        })()`);
        if (!clicked) throw new Error(`Button not found: ${label}`);
    }

    close() {
        this.socket.close();
    }
}
