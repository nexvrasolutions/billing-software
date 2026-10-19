"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BillMathError, computeBill, discountWithinLimit, type BillResult } from "@/lib/bill-maths";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import { addToSyncQueue } from "@/lib/offline/SyncQueueService";
import { generateProvisionalReference, isProvisionalInvoiceNo } from "@/lib/invoiceNumber";
import { fetchSessionIdentity, pricingModeFromMe, SESSION_CHECK_TIMEOUT_MS } from "@/lib/offline/sessionIdentity";
import { readRememberedIdentity, restoreOfflineSession } from "@/lib/offline/offlineAccess";
import { checkOfflineWorkAllowed } from "@/lib/offline/offlineSession";
import { describeQueueWriteError } from "@/lib/offline/storageDurability";
import { offlineDB, type OfflineDatabase } from "@/lib/offline/db";
import { useOnlineStatus } from "@/lib/offline/useOnlineStatus";
import {
  saveCachedProducts,
  getCachedProductsForTenant,
  mapApiProductToPosItem,
  mapCachedProductToPosItem,
  decrementCachedProductStock,
  type PosItemDto,
} from "@/lib/offline/productCatalogueCache";
import {
  saveCachedCustomers,
  searchCachedCustomers,
  savePendingOfflineCustomer,
} from "@/lib/offline/customerCache";

export type { PosItemDto };

export interface CustomerDto {
  id: string;
  name: string;
  phone: string | null;
  balancePaise: number;
  creditLimitPaise: number;
}

interface Line {
  key: string;
  item: PosItemDto;
  quantity: string;
  discount: string;
  serial: string;
}

interface Cart {
  lines: Line[];
  billDiscount: string;
  customer: CustomerDto | null;
  card: string;
  upi: string;
  reference: string;
  cashReceived: string;
}

const EMPTY_CART: Cart = {
  lines: [],
  billDiscount: "",
  customer: null,
  card: "",
  upi: "",
  reference: "",
  cashReceived: "",
};

const HELD_KEY = "pos-held-carts";
const HELD_EVENT = "pos-held-changed";

const paiseOf = (text: string): number | null => (text.trim() === "" ? 0 : rupeesToPaise(text));

function readHeldRaw(): string {
  try {
    return window.localStorage.getItem(HELD_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function subscribeHeld(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(HELD_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(HELD_EVENT, onChange);
  };
}

function parseHeld(raw: string): { at: string; cart: Cart }[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? (value as { at: string; cart: Cart }[]) : [];
  } catch {
    return [];
  }
}

function writeHeld(held: { at: string; cart: Cart }[]): void {
  try {
    window.localStorage.setItem(HELD_KEY, JSON.stringify(held));
  } catch {
    // Storage blocked: holding just does not persist.
  }
  window.dispatchEvent(new Event(HELD_EVENT));
}

export interface CreatePosSalePayloadInput {
  branchName?: string;
  invoiceNo?: string;
  provisionalInvoiceNo?: string;
  operationId?: string;
  lines: Line[];
  customer: CustomerDto | null;
  reference?: string;
  card?: string;
  upi?: string;
  cashReceived?: string;
  payablePaise?: number;
  cashKept: number;
  nonCash: number;
  onCredit: number;
  roundOff?: boolean;
}

export function createPosSalePayload(params: CreatePosSalePayloadInput): Record<string, unknown> {
  const provRef = (
    params.provisionalInvoiceNo?.trim() ||
    params.reference?.trim() ||
    (params.invoiceNo && isProvisionalInvoiceNo(params.invoiceNo) ? params.invoiceNo.trim() : undefined) ||
    generateProvisionalReference()
  ).toUpperCase();

  const invoiceNo = (params.invoiceNo?.trim() || provRef).toUpperCase();

  const warehouse = {
    name: params.branchName?.trim() || "Main Store",
  };

  const items = params.lines.map((l) => {
    const qty = Number(l.quantity) || 1;
    const unitPrice = l.item.pricePaise / 100;
    const discountRupees = Number(l.discount) || 0;
    const gross = qty * unitPrice;
    const discountRate =
      gross > 0 && discountRupees > 0
        ? Number(Math.min(100, Math.max(0, (discountRupees / gross) * 100)).toFixed(2))
        : undefined;

    const hasConfiguredTax =
      l.item.isTaxConfigured !== false &&
      typeof l.item.taxRate === "string" &&
      l.item.taxRate.trim() !== "";

    return {
      productId: l.item.variantId,
      quantity: qty,
      unitPrice,
      ...(discountRate !== undefined ? { discountRate } : {}),
      ...(discountRupees > 0 ? { discountAmount: discountRupees } : {}),
      ...(hasConfiguredTax ? { taxRate: Number(l.item.taxRate) } : {}),
    };
  });

  const isHex24 = (id?: string) => Boolean(id && /^[0-9a-fA-F]{24}$/.test(id));
  const customerId = isHex24(params.customer?.id) ? params.customer?.id : undefined;

  const paidAmount = Number(((params.nonCash + params.cashKept) / 100).toFixed(2));

  const card = paiseOf(params.card ?? "");
  const upi = paiseOf(params.upi ?? "");

  const paymentComponents: {
    method: "cash" | "upi" | "card" | "bank";
    amount: number;
    referenceNo?: string;
  }[] = [];

  if (params.cashKept > 0) {
    paymentComponents.push({
      method: "cash",
      amount: Number((params.cashKept / 100).toFixed(2)),
    });
  }

  if ((upi ?? 0) > 0) {
    paymentComponents.push({
      method: "upi",
      amount: Number(((upi ?? 0) / 100).toFixed(2)),
      ...(params.reference?.trim() ? { referenceNo: params.reference.trim() } : {}),
    });
  }

  if ((card ?? 0) > 0) {
    paymentComponents.push({
      method: "card",
      amount: Number(((card ?? 0) / 100).toFixed(2)),
      ...(params.reference?.trim() ? { referenceNo: params.reference.trim() } : {}),
    });
  }

  const paymentMethod =
    paymentComponents.length > 1
      ? undefined
      : params.cashKept > 0
      ? "cash"
      : (upi ?? 0) > 0
      ? "upi"
      : (card ?? 0) > 0
      ? "card"
      : params.onCredit > 0
      ? "credit"
      : undefined;

  const notes = params.customer?.name
    ? `Customer: ${params.customer.name}${params.customer.phone ? ` (${params.customer.phone})` : ""}`
    : undefined;

  return {
    invoiceNo,
    provisionalInvoiceNo: provRef,
    ...(params.operationId ? { operationId: params.operationId } : {}),
    warehouse,
    items,
    ...(customerId ? { customerId } : {}),
    paidAmount,
    ...(paymentMethod ? { paymentMethod } : {}),
    ...(paymentComponents.length > 0 ? { paymentComponents } : {}),
    ...(params.roundOff !== undefined ? { roundOff: params.roundOff } : {}),
    ...(notes ? { notes } : {}),
    saleDate: new Date().toISOString(),
  };
}

export function matchCatalogItems(
  catalog: PosItemDto[],
  query: string
): { exact?: PosItemDto; candidates: PosItemDto[] } {
  const value = query.trim().toUpperCase();
  if (!value) return { candidates: [] };

  // 1. Exact match by barcode or SKU takes priority (canonical uppercase)
  const exact = catalog.find(
    (item) =>
      (item.barcode && item.barcode.trim().toUpperCase() === value) ||
      item.sku.trim().toUpperCase() === value
  );
  if (exact) {
    return { exact, candidates: [exact] };
  }

  // 2. Substring match by name, SKU, or barcode
  const lowerValue = query.trim().toLowerCase();
  const candidates = catalog.filter(
    (item) =>
      item.name.toLowerCase().includes(lowerValue) ||
      item.sku.toLowerCase().includes(lowerValue) ||
      (item.barcode && item.barcode.toLowerCase().includes(lowerValue))
  );

  return { candidates };
}

export type PosSaleSubmitOutcome =
  | { outcome: "online_saved"; invoiceId: string }
  | { outcome: "offline_queued"; message: string; operationId?: string; provisionalInvoiceNo?: string }
  | { outcome: "server_error_queued"; message: string; operationId?: string; provisionalInvoiceNo?: string }
  | { outcome: "rejected_by_server"; message: string }
  | { outcome: "queue_failed"; message: string };

export interface SubmitPosSaleDeps {
  fetchFn?: typeof fetch;
  addToSyncQueueFn?: typeof addToSyncQueue;
  tenantId?: string;
  db?: OfflineDatabase;
}

export async function submitPosSale(
  salePayload: Record<string, unknown>,
  deps: SubmitPosSaleDeps = {}
): Promise<PosSaleSubmitOutcome> {
  const fetchFn = deps.fetchFn ?? fetch;
  const enqueueFn = deps.addToSyncQueueFn ?? addToSyncQueue;
  const db = deps.db ?? offlineDB;

  const items = Array.isArray(salePayload.items)
    ? (salePayload.items as Array<{ productId?: string; quantity?: number }>)
    : [];

  // Inspect line items for temporary client IDs or pending offline products
  const dependsOnSet = new Set<string>();
  let hasPendingProduct = false;

  for (const line of items) {
    const pId = String(line?.productId || "").trim();
    if (!pId) continue;
    const isTempId = pId.startsWith("prod_") || !/^[0-9a-fA-F]{24}$/.test(pId);

    let cached: any = undefined;
    try {
      if (typeof indexedDB !== "undefined" || deps.db) {
        cached = await db.cachedProducts.where("productId").equals(pId).first().catch(() => undefined);
      }
    } catch {
      // IndexedDB missing in test/node environment
    }

    if (isTempId || cached?.syncStatus === "PENDING" || cached?.operationId) {
      hasPendingProduct = true;
      if (cached?.operationId) {
        dependsOnSet.add(cached.operationId);
      }
    }
  }

  // Inspect customer for temporary client ID or pending offline customer
  let hasPendingCustomer = false;
  const cId = String(salePayload.customerId || "").trim();
  if (cId) {
    const isTempCust = cId.startsWith("cust_") || !/^[0-9a-fA-F]{24}$/.test(cId);
    let cachedCust: any = undefined;
    try {
      if (typeof indexedDB !== "undefined" || deps.db) {
        cachedCust = await db.cachedCustomers?.where("customerId").equals(cId).first().catch(() => undefined);
      }
    } catch {
      // IndexedDB missing in test/node environment
    }

    if (isTempCust || cachedCust?.syncStatus === "PENDING" || cachedCust?.operationId) {
      hasPendingCustomer = true;
      if (cachedCust?.operationId) {
        dependsOnSet.add(cachedCust.operationId);
      }
    }
  }

  const dependsOn = Array.from(dependsOnSet);

  async function decrementLocalStock() {
    if (typeof indexedDB === "undefined" && !deps.db) return;
    let tId = deps.tenantId;
    if (!tId) {
      try {
        const remembered = await readRememberedIdentity().catch(() => null);
        tId = remembered?.tenantId;
      } catch {}
    }
    if (tId) {
      for (const line of items) {
        if (line?.productId) {
          try {
            await decrementCachedProductStock(String(line.productId), tId, Number(line.quantity || 1), db).catch(() => undefined);
          } catch {}
        }
      }
    }
  }

  // If sale references pending product(s) or customer(s), never allow it to reach SalesService.createSale() before dependencies sync
  if (hasPendingProduct || hasPendingCustomer) {
    try {
      const queueResult = await enqueueFn({
        entityType: "Sale",
        operationType: "CREATE",
        payload: salePayload,
        dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      });

      await decrementLocalStock();

      return {
        outcome: "offline_queued",
        message: hasPendingCustomer && hasPendingProduct
          ? "Offline bill saved locally to IndexedDB queue. It depends on pending customer and product creation and will synchronize once confirmed."
          : hasPendingCustomer
          ? "Offline bill saved locally to IndexedDB queue. It depends on pending customer creation and will synchronize once confirmed."
          : "Offline bill saved locally to IndexedDB queue. It depends on pending product creation and will synchronize once confirmed.",
        operationId: queueResult?.operationId,
        provisionalInvoiceNo: String(salePayload.provisionalInvoiceNo || salePayload.invoiceNo || ""),
      };
    } catch (queueErr) {
      return {
        outcome: "queue_failed",
        message: describeQueueWriteError(queueErr),
      };
    }
  }

  try {
    const res = await fetchFn("/api/sales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(salePayload),
    });

    if (res.ok) {
      const data = await res.json().catch(() => null);
      const invoiceId = data?.sale?._id || data?.sale?.id || crypto.randomUUID();
      return { outcome: "online_saved", invoiceId };
    }

    // Server error (5xx): queue into offline pending queue
    if (res.status >= 500) {
      try {
        const queueResult = await enqueueFn({
          entityType: "Sale",
          operationType: "CREATE",
          payload: salePayload,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
        });
        await decrementLocalStock();
        return {
          outcome: "server_error_queued",
          message: "Server temporarily unreachable. Bill saved locally to IndexedDB queue.",
          operationId: queueResult?.operationId,
          provisionalInvoiceNo: String(salePayload.provisionalInvoiceNo || salePayload.invoiceNo || ""),
        };
      } catch (queueErr) {
        return {
          outcome: "queue_failed",
          message: describeQueueWriteError(queueErr),
        };
      }
    }

    // HTTP 4xx business/validation errors: reject, do NOT queue
    const errData = await res.json().catch(() => null);
    return {
      outcome: "rejected_by_server",
      message: errData?.message || "Failed to save sale.",
    };
  } catch (_networkError) {
    // Genuine network failure: attempt to queue offline
    try {
      const queueResult = await enqueueFn({
        entityType: "Sale",
        operationType: "CREATE",
        payload: salePayload,
        dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      });
      await decrementLocalStock();
      return {
        outcome: "offline_queued",
        message: "Offline bill saved locally to IndexedDB queue. It will synchronize when online.",
        operationId: queueResult?.operationId,
        provisionalInvoiceNo: String(salePayload.provisionalInvoiceNo || salePayload.invoiceNo || ""),
      };
    } catch (queueErr) {
      return {
        outcome: "queue_failed",
        message: describeQueueWriteError(queueErr),
      };
    }
  }
}

export function PosScreen(props: {
  branches?: { id: string; name: string }[];
}): ReactNode {
  const router = useRouter();
  const branches = props.branches ?? [{ id: "main", name: "Main Store" }];
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "main");
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [code, setCode] = useState("");
  const [catalog, setCatalog] = useState<PosItemDto[]>([]);
  const [hits, setHits] = useState<PosItemDto[]>([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerHits, setCustomerHits] = useState<CustomerDto[]>([]);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const heldRaw = useSyncExternalStore(subscribeHeld, readHeldRaw, () => "[]");
  const held = useMemo(() => parseHeld(heldRaw), [heldRaw]);
  const scanRef = useRef<HTMLInputElement>(null);

  const [pricingMode, setPricingMode] = useState<"tax_inclusive" | "tax_exclusive">("tax_inclusive");
  const [isOfflineCatalogue, setIsOfflineCatalogue] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [emptyOfflineNotice, setEmptyOfflineNotice] = useState(false);
  const [currentTenantId, setCurrentTenantId] = useState<string | null>(null);
  const [offlineReceipt, setOfflineReceipt] = useState<{
    provisionalRef: string;
    operationId: string;
    payablePaise: number;
    itemCount: number;
    customerName?: string;
    timestamp: string;
  } | null>(null);

  // Load products from API when online, or fall back to verified offline cache
  const loadCatalog = useCallback(async () => {
    setEmptyOfflineNotice(false);

    // 1. Attempt online fetch
    try {
      const res = await fetch("/api/products", {
        credentials: "same-origin",
        signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
      });

      // Definitively rejected session (401/403): do not expose offline cache
      if (res.status === 401 || res.status === 403) {
        setCatalog([]);
        setIsOfflineCatalogue(false);
        setCachedAt(null);
        setMessage({
          kind: "error",
          text:
            res.status === 401
              ? "Please sign in to access the product catalogue."
              : "You do not have permission to read products.",
        });
        return;
      }

      if (res.ok) {
        const data = await res.json();
        if (data?.products && Array.isArray(data.products)) {
          // Determine authenticated tenantId for safe cache isolation
          let tenantId: string | null = null;
          if (data.products.length > 0 && data.products[0]?.tenantId) {
            tenantId = String(data.products[0].tenantId);
          }
          if (!tenantId) {
            const liveIdentity = await fetchSessionIdentity().catch(() => null);
            tenantId = liveIdentity?.tenantId ?? null;
          }

          // Fetch business pricing mode from authenticated session
          try {
            const meRes = await fetch("/api/auth/me", {
              credentials: "same-origin",
              signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
            }).catch(() => null);
            if (meRes?.ok) {
              const meData = await meRes.json();
              const mode = pricingModeFromMe(meData);
              setPricingMode(mode);
              const tId = meData?.tenant?.id || meData?.user?.tenantId || tenantId;
              if (tId && typeof window !== "undefined") {
                try {
                  window.localStorage.setItem(`pos_pricing_mode:${tId}`, mode);
                } catch {}
              }
            }
          } catch {}

          // Save to offline cache safely if tenantId is known
          if (tenantId) {
            setCurrentTenantId(tenantId);
            await saveCachedProducts(tenantId, data.products).catch((err) => {
              console.warn("Failed to update offline product cache:", err);
            });

            // Load and cache customers in background for offline use
            fetch("/api/customers", {
              credentials: "same-origin",
              signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
            })
              .then((r) => r.json())
              .then((custData) => {
                if (custData?.success && Array.isArray(custData.customers)) {
                  saveCachedCustomers(custData.customers, tenantId!);
                }
              })
              .catch(() => {});
          }

          // Filter inactive products for POS selection
          const activeProducts = data.products.filter(
            (p: { status?: string }) => p.status !== "inactive"
          );
          const mapped: PosItemDto[] = activeProducts.map(mapApiProductToPosItem);

          setCatalog(mapped);
          setIsOfflineCatalogue(false);
          setCachedAt(null);
          return;
        }
      }
      // If res not ok (e.g. 500, 502, 503, 504), proceed to offline fallback
    } catch {
      // Network error, fetch failed, or offline: proceed to offline fallback
    }

    // 2. Offline Fallback: authenticated, authorized cached products only
    try {
      const restored = await restoreOfflineSession().catch(() => null);
      if (!restored || !restored.ok || !restored.identity || !restored.identity.tenantId) {
        setCatalog([]);
        setIsOfflineCatalogue(false);
        setCachedAt(null);
        setMessage({
          kind: "error",
          text:
            restored?.reason ||
            "No active session. Please sign in online before working offline.",
        });
        return;
      }

      const identity = restored.identity;
      setCurrentTenantId(identity.tenantId);

      const cached = await getCachedProductsForTenant(identity.tenantId);

      if (cached.length === 0) {
        setCatalog([]);
        setIsOfflineCatalogue(false);
        setCachedAt(null);
        setEmptyOfflineNotice(true);
        return;
      }

      // Filter inactive products from cached catalogue for POS selection
      const activeCached = cached.filter((p) => p.status !== "inactive");
      const mapped = activeCached.map(mapCachedProductToPosItem);

      if (typeof window !== "undefined" && identity?.tenantId) {
        try {
          const cachedMode = window.localStorage.getItem(`pos_pricing_mode:${identity.tenantId}`);
          if (cachedMode === "tax_exclusive" || cachedMode === "tax_inclusive") {
            setPricingMode(cachedMode);
          }
        } catch {}
      }

      setCatalog(mapped);
      setIsOfflineCatalogue(true);
      const latestTime = cached[0]?.cachedAt
        ? new Date(cached[0].cachedAt).toLocaleTimeString("en-IN", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : null;
      setCachedAt(latestTime);
    } catch {
      setCatalog([]);
      setIsOfflineCatalogue(false);
      setCachedAt(null);
      setMessage({
        kind: "error",
        text: "Unable to load product catalogue offline.",
      });
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useOnlineStatus(() => {
    // When reconnecting online, refresh catalogue to update cache
    loadCatalog();
  });

  // Bill preview computation matching reference bill-maths
  const preview = useMemo((): { bill: BillResult | null; problem: string | null } => {
    if (cart.lines.length === 0) return { bill: null, problem: null };

    const unconfigured = cart.lines.find(
      (l) => l.item.isTaxConfigured === false || typeof l.item.taxRate !== "string" || l.item.taxRate.trim() === ""
    );
    if (unconfigured) {
      return {
        bill: null,
        problem: `Product "${unconfigured.item.name}" (${unconfigured.item.sku}) has no tax rate configured. Configure product tax rate before checkout.`,
      };
    }

    const discounts = cart.lines.map((l) => paiseOf(l.discount));
    const billDiscount = paiseOf(cart.billDiscount);
    if (discounts.some((d) => d === null) || billDiscount === null) {
      return { bill: null, problem: "Enter discounts in rupees, e.g. 50 or 49.50." };
    }
    try {
      const bill = computeBill({
        lines: cart.lines.map((l, i) => ({
          quantity: l.quantity.trim() || "1",
          unitPricePaise: l.item.pricePaise,
          taxRate: l.item.taxRate,
          discountPaise: discounts[i] ?? 0,
        })),
        pricesIncludeTax: pricingMode === "tax_inclusive",
        chargesGst: true,
        interState: false,
        billDiscountPaise: billDiscount,
        roundOff: true,
      });
      return { bill, problem: null };
    } catch (error) {
      return {
        bill: null,
        problem: error instanceof BillMathError ? error.message : "Please check the bill.",
      };
    }
  }, [cart, pricingMode]);

  const payable = preview.bill?.payablePaise ?? 0;
  const card = paiseOf(cart.card);
  const upi = paiseOf(cart.upi);
  const cashReceived = paiseOf(cart.cashReceived);
  const paymentsValid = card !== null && upi !== null && cashReceived !== null;
  const nonCash = (card ?? 0) + (upi ?? 0);
  const cashKept = Math.max(0, Math.min(cashReceived ?? 0, payable - nonCash));
  const change = (cashReceived ?? 0) - cashKept;
  const onCredit = payable - nonCash - cashKept;

  const update = (change: Partial<Cart>) => {
    setCart((c) => ({ ...c, ...change }));
  };

  const updateLine = (key: string, change: Partial<Line>) => {
    setCart((c) => ({
      ...c,
      lines: c.lines.map((l) => (l.key === key ? { ...l, ...change } : l)),
    }));
  };

  const addItem = (item: PosItemDto) => {
    setCart((c) => {
      const same = item.trackSerial ? undefined : c.lines.find((l) => l.item.variantId === item.variantId);
      if (same !== undefined && /^\d+$/.test(same.quantity)) {
        return {
          ...c,
          lines: c.lines.map((l) =>
            l === same ? { ...l, quantity: String(Number(l.quantity) + 1) } : l
          ),
        };
      }
      return {
        ...c,
        lines: [
          ...c.lines,
          { key: crypto.randomUUID(), item, quantity: "1", discount: "", serial: "" },
        ],
      };
    });
    setHits([]);
    setCode("");
    setMessage(null);
  };

  const scan = (text: string) => {
    const value = text.trim();
    if (value === "") return;

    const { exact, candidates } = matchCatalogItems(catalog, value);

    if (exact) {
      addItem(exact);
    } else if (candidates.length === 1 && candidates[0]) {
      addItem(candidates[0]);
    } else if (candidates.length > 1) {
      setHits(candidates);
      setMessage(null);
    } else {
      setHits([]);
      setMessage({ kind: "error", text: `Nothing found for "${text}".` });
    }
  };

  const pick = (variantId: string) => {
    const item = catalog.find((c) => c.variantId === variantId);
    if (item) addItem(item);
  };

  const searchCustomers = async () => {
    const q = customerQuery.trim().toLowerCase();
    if (!q) return;

    // 1. Search local cache first (works offline and online)
    let foundLocal: CustomerDto[] = [];
    try {
      const activeTenantId = currentTenantId || (await readRememberedIdentity().catch(() => null))?.tenantId;
      if (activeTenantId) {
        const cached = await searchCachedCustomers(q, activeTenantId);
        foundLocal = cached.map((c) => ({
          id: c.customerId,
          name: c.name,
          phone: c.phone || null,
          balancePaise: 0,
          creditLimitPaise: 0,
        }));
      }
    } catch {
      // IndexedDB missing / offline fallback
    }

    if (foundLocal.length === 1 && foundLocal[0]) {
      update({ customer: foundLocal[0] });
      setCustomerHits([]);
      setMessage({ kind: "info", text: `Selected customer "${foundLocal[0].name}".` });
      return;
    } else if (foundLocal.length > 1) {
      setCustomerHits(foundLocal);
      setMessage({ kind: "info", text: `Found ${foundLocal.length} matching customers.` });
      return;
    }

    // 2. If online and not found in cache, search /api/customers
    if (typeof navigator !== "undefined" && navigator.onLine) {
      try {
        const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}`);
        const data = await res.json().catch(() => null);
        if (data?.success && Array.isArray(data.customers) && data.customers.length > 0) {
          const apiMatches: CustomerDto[] = data.customers.map((c: any) => ({
            id: c._id,
            name: c.name,
            phone: c.phone || null,
            balancePaise: 0,
            creditLimitPaise: 0,
          }));

          const activeTenantId = currentTenantId || (await readRememberedIdentity().catch(() => null))?.tenantId;
          if (activeTenantId) {
            await saveCachedCustomers(data.customers, activeTenantId).catch(() => {});
          }

          if (apiMatches.length === 1 && apiMatches[0]) {
            update({ customer: apiMatches[0] });
            setCustomerHits([]);
            setMessage({ kind: "info", text: `Selected customer "${apiMatches[0].name}".` });
            return;
          } else {
            setCustomerHits(apiMatches);
            setMessage({ kind: "info", text: `Found ${apiMatches.length} matching customers.` });
            return;
          }
        }
      } catch {}
    }

    setCustomerHits([]);
    setMessage({ kind: "error", text: `No customer found matching "${customerQuery}". Add new customer below.` });
  };

  const addCustomer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("customerName") || "").trim();
    const phone = String(form.get("customerPhone") || "").trim();
    if (!name) return;

    let localId = `cust_${crypto.randomUUID()}`;
    const opId = crypto.randomUUID();

    try {
      const activeTenantId = currentTenantId || (await readRememberedIdentity().catch(() => null))?.tenantId;
      if (activeTenantId) {
        const saved = await savePendingOfflineCustomer(
          { name, phone: phone || undefined },
          activeTenantId,
          offlineDB,
          opId,
          localId
        );
        localId = saved.customer.customerId;

        await addToSyncQueue({
          entityType: "Customer",
          operationType: "CREATE",
          operationId: opId,
          payload: {
            localId,
            name,
            phone: phone || undefined,
            status: "active",
          },
        });
      }
    } catch (err) {
      console.warn("Could not persist customer to offline cache/queue:", err);
    }

    const newCust: CustomerDto = {
      id: localId,
      name,
      phone: phone || null,
      balancePaise: 0,
      creditLimitPaise: 0,
    };
    update({ customer: newCust });
    setCustomerHits([]);
    setMessage({ kind: "info", text: `Customer "${name}" added.` });
  };

  const hold = () => {
    if (cart.lines.length === 0) return;
    const next = [...held, { at: new Date().toLocaleTimeString("en-IN"), cart }];
    writeHeld(next);
    setCart(EMPTY_CART);
  };

  const resume = (index: number) => {
    const entry = held[index];
    if (entry === undefined) return;
    const next = held.filter((_, i) => i !== index);
    writeHeld(next);
    setCart(entry.cart);
  };

  const save = () => {
    if (preview.bill === null || preview.problem !== null || !paymentsValid || pending) return;
    if (onCredit > 0 && cart.customer === null) {
      setMessage({
        kind: "error",
        text: "Not fully paid: choose a customer to put the rest on their account.",
      });
      return;
    }

    startTransition(async () => {
      const activeBranch = branches.find((b) => b.id === branchId) ?? branches[0];
      const salePayload = createPosSalePayload({
        branchName: activeBranch?.name,
        lines: cart.lines,
        customer: cart.customer,
        reference: cart.reference,
        card: cart.card,
        upi: cart.upi,
        cashReceived: cart.cashReceived,
        payablePaise: preview.bill?.payablePaise ?? 0,
        cashKept,
        nonCash,
        onCredit,
        roundOff: true,
      });

      const result = await submitPosSale(salePayload, {
        tenantId: currentTenantId ?? undefined,
      });

      if (result.outcome === "online_saved") {
        setCart(EMPTY_CART);
        router.push(`/sales/${result.invoiceId}?saved=1`);
        return;
      }

      if (result.outcome === "offline_queued" || result.outcome === "server_error_queued") {
        const provRef = result.provisionalInvoiceNo || String(salePayload.provisionalInvoiceNo || "OFFLINE-BILL");
        setOfflineReceipt({
          provisionalRef: provRef,
          operationId: result.operationId || "",
          payablePaise: preview.bill?.payablePaise ?? 0,
          itemCount: cart.lines.length,
          customerName: cart.customer?.name,
          timestamp: new Date().toLocaleTimeString("en-IN"),
        });
        setCart(EMPTY_CART);
        setMessage({
          kind: "info",
          text: result.message,
        });
        return;
      }

      // rejected_by_server or queue_failed
      setMessage({
        kind: "error",
        text: result.message,
      });
    });
  };

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === "F2") {
        event.preventDefault();
        scanRef.current?.focus();
      } else if (event.key === "F9") {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", keys);
    return () => {
      window.removeEventListener("keydown", keys);
    };
  });

  const bill = preview.bill;
  const needsCustomer = onCredit > 0 && cart.customer === null;
  const saveHint =
    cart.lines.length === 0
      ? "Add an item to start a bill."
      : needsCustomer && paymentsValid && preview.problem === null
      ? "Part of this bill is unpaid. Take the full amount, or choose a customer to put the rest on their account."
      : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      {/* Left Column: Cart & Items */}
      <section className="flex flex-col gap-3" aria-label="Cart">
        {offlineReceipt && (
          <div
            role="status"
            className="rounded-lg border-2 border-amber-500/60 bg-amber-500/10 p-4 text-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/20 pb-2">
              <div>
                <span className="font-semibold text-amber-900 dark:text-amber-200">
                  Provisional Receipt — Pending Server Confirmation
                </span>
                <p className="text-xs text-amber-800/90 dark:text-amber-300">
                  Offline bill recorded locally in IndexedDB queue.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => window.print()}
                  className="h-7 text-xs"
                >
                  Print Receipt
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setOfflineReceipt(null)}
                  className="h-7 text-xs"
                >
                  Next Sale
                </Button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">Provisional Reference: </span>
                <strong className="font-mono text-sm">{offlineReceipt.provisionalRef}</strong>
              </div>
              <div className="text-right">
                <span className="text-muted-foreground">Amount: </span>
                <strong>{formatPaise(offlineReceipt.payablePaise)}</strong> ({offlineReceipt.itemCount} items)
              </div>
            </div>
            <p className="mt-2 text-[11px] text-amber-800/80 dark:text-amber-300/80 italic">
              Notice: This provisional reference is for customer handover while offline. It is not an authoritative GST tax invoice. The permanent tax invoice number will be allocated on server synchronization.
            </p>
          </div>
        )}

        {isOfflineCatalogue && (
          <div
            role="status"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
          >
            <div className="flex items-center gap-2 font-medium">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
              Working with Offline Product Catalogue
            </div>
            <p className="mt-1 text-xs opacity-90">
              Prices and stock levels are loaded from local cache{cachedAt ? ` (cached ${cachedAt})` : ""} and may be stale. New sales will be queued locally and synchronized once reconnected.
            </p>
          </div>
        )}

        {emptyOfflineNotice && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <div className="font-medium">Offline Catalogue Unavailable</div>
            <p className="mt-1 text-xs opacity-90">
              No cached products were found for this account. Please connect to the internet to load your catalogue before working offline.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          {branches.length > 1 && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="pos-branch">Branch</Label>
              <select
                id="pos-branch"
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                disabled={cart.lines.length > 0}
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <form
            className="flex flex-1 flex-col gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              scan(code);
            }}
          >
            <Label htmlFor="pos-scan">Scan a barcode, or type a SKU or name (F2)</Label>
            <div className="flex gap-2">
              <Input
                id="pos-scan"
                ref={scanRef}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                autoComplete="off"
                maxLength={100}
                placeholder="Scan barcode or type name..."
              />
              <Button type="submit" variant="outline" disabled={pending}>
                Add
              </Button>
            </div>
          </form>
        </div>

        {hits.length > 0 && (
          <ul className="flex flex-col divide-y rounded-lg border bg-card" aria-label="Search results">
            {hits.map((h) => (
              <li key={h.variantId}>
                <button
                  type="button"
                  className="w-full p-2 text-left text-sm hover:bg-muted"
                  onClick={() => pick(h.variantId)}
                >
                  {h.name}{" "}
                  {h.syncStatus === "PENDING" && (
                    <span className="inline-block rounded bg-amber-500/10 border border-amber-500/30 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400 mr-1">
                      Pending sync
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    {h.sku} · {formatPaise(h.pricePaise)}
                    {h.barcode ? ` · barcode ${h.barcode}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {message !== null && (
          <p
            role={message.kind === "error" ? "alert" : "status"}
            className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
          >
            {message.text}
          </p>
        )}

        {cart.lines.length === 0 && <p className="text-sm text-muted-foreground">The cart is empty.</p>}

        {cart.lines.length > 0 && (
          <div className="table-scroll">
            <table className="w-full text-sm" aria-label="Cart lines">
              <thead className="border-b text-left">
                <tr>
                  <th className="p-1 font-medium">Item</th>
                  <th className="p-1 font-medium">Qty</th>
                  <th className="p-1 font-medium">Discount ₹</th>
                  <th className="p-1 text-right font-medium">Amount</th>
                  <th className="p-1" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {cart.lines.map((l, i) => (
                  <tr key={l.key} aria-label={l.item.name}>
                    <td className="min-w-44 p-1">
                      {l.item.name}
                      {l.item.syncStatus === "PENDING" && (
                        <span className="ml-1.5 inline-block rounded bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                          Pending sync
                        </span>
                      )}
                      <div className="text-xs text-muted-foreground">
                        {l.item.sku}
                        {l.item.barcode ? ` · barcode ${l.item.barcode}` : ""} ·{" "}
                        {formatPaise(l.item.pricePaise)} · in stock{" "}
                        {formatQuantity(l.item.inStock)}
                        {l.item.isTaxConfigured === false ? (
                          <span className="ml-1 inline-block rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                            Tax unconfigured
                          </span>
                        ) : (
                          <span> · {l.item.taxLabel}</span>
                        )}
                      </div>
                    </td>
                    <td className="p-1">
                      <Input
                        aria-label={`Quantity of ${l.item.name}`}
                        value={l.quantity}
                        onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                        className="h-9 w-20"
                        maxLength={16}
                      />
                    </td>
                    <td className="p-1">
                      <Input
                        aria-label={`Discount on ${l.item.name}`}
                        value={l.discount}
                        onChange={(e) => updateLine(l.key, { discount: e.target.value })}
                        className="h-9 w-24"
                        placeholder="0"
                        maxLength={16}
                      />
                    </td>
                    <td className="p-1 text-right tabular-nums">
                      {bill?.lines[i] === undefined ? "–" : formatPaise(bill.lines[i].totalPaise)}
                    </td>
                    <td className="p-1 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${l.item.name}`}
                        onClick={() => {
                          update({ lines: cart.lines.filter((x) => x.key !== l.key) });
                        }}
                      >
                        ✕
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={hold} disabled={cart.lines.length === 0}>
            Hold this bill
          </Button>
          {held.map((h, i) => (
            <Button
              key={`${h.at}-${String(i)}`}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => resume(i)}
              disabled={cart.lines.length > 0}
            >
              Resume ({h.cart.lines.length} items, {h.at})
            </Button>
          ))}
        </div>
      </section>

      {/* Right Column: Payment & Totals Aside */}
      <aside className="flex flex-col gap-3 rounded-lg border bg-card p-3" aria-label="Payment">
        <section className="flex flex-col gap-1" aria-label="Customer">
          {cart.customer === null ? (
            <>
              <Label htmlFor="pos-customer">Customer (phone or name, optional)</Label>
              <div className="flex gap-2">
                <Input
                  id="pos-customer"
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  maxLength={100}
                  placeholder="Customer name or phone"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={searchCustomers}
                  disabled={pending || customerQuery.trim() === ""}
                >
                  Find
                </Button>
              </div>

              {customerHits.length > 0 && (
                <div className="flex flex-col gap-1 p-2 border rounded-md bg-muted/40 text-xs mt-1">
                  <span className="font-medium text-muted-foreground">Matching customers:</span>
                  <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                    {customerHits.map((cust) => (
                      <button
                        key={cust.id}
                        type="button"
                        className="flex justify-between items-center p-1.5 rounded hover:bg-primary/10 text-left w-full border border-transparent hover:border-border"
                        onClick={() => {
                          update({ customer: cust });
                          setCustomerHits([]);
                          setMessage({ kind: "info", text: `Selected customer "${cust.name}".` });
                        }}
                      >
                        <span className="font-semibold">{cust.name}</span>
                        <span className="text-muted-foreground">{cust.phone || "No phone"}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <form onSubmit={addCustomer} className="flex flex-wrap gap-1 mt-1" aria-label="New customer">
                <Input
                  name="customerName"
                  placeholder="New customer name"
                  aria-label="New customer name"
                  className="h-8 min-w-0 flex-1 text-xs"
                  maxLength={200}
                  required
                />
                <Input
                  name="customerPhone"
                  placeholder="Phone"
                  aria-label="New customer phone"
                  className="h-8 w-28 text-xs"
                  maxLength={20}
                />
                <Button type="submit" variant="outline" size="xs" disabled={pending}>
                  Add
                </Button>
              </form>
            </>
          ) : (
            <div className="flex items-center justify-between text-sm">
              <span>
                <strong>{cart.customer.name}</strong> {cart.customer.phone ?? ""}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={() => update({ customer: null })}>
                Change
              </Button>
            </div>
          )}
        </section>

        <div className="flex flex-col gap-1">
          <Label htmlFor="pos-bill-discount">Discount on the whole bill (₹)</Label>
          <Input
            id="pos-bill-discount"
            value={cart.billDiscount}
            onChange={(e) => update({ billDiscount: e.target.value })}
            placeholder="0"
            maxLength={16}
          />
        </div>

        <dl className="grid grid-cols-2 gap-1 text-sm border-t pt-2" aria-label="Bill totals">
          <dt>Items</dt>
          <dd className="text-right tabular-nums">{formatPaise(bill?.grossPaise ?? 0)}</dd>
          <dt>Discount</dt>
          <dd className="text-right tabular-nums">{formatPaise(bill?.discountPaise ?? 0)}</dd>
          <dt>{pricingMode === "tax_inclusive" ? "GST (included)" : "GST (added)"}</dt>
          <dd className="text-right tabular-nums">{formatPaise(bill?.taxPaise ?? 0)}</dd>
          <dt>Round off</dt>
          <dd className="text-right tabular-nums">{formatPaise(bill?.roundOffPaise ?? 0)}</dd>
          <dt className="text-lg font-semibold border-t pt-1">To pay</dt>
          <dd className="text-right text-lg font-semibold tabular-nums border-t pt-1">{formatPaise(payable)}</dd>
        </dl>

        {preview.problem !== null && (
          <p role="alert" className="text-sm text-destructive">
            {preview.problem}
          </p>
        )}

        <div className="grid grid-cols-2 gap-2 border-t pt-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="pos-cash">Cash received (₹)</Label>
            <Input
              id="pos-cash"
              value={cart.cashReceived}
              onChange={(e) => update({ cashReceived: e.target.value })}
              placeholder="0"
              maxLength={16}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="pos-upi">UPI (₹)</Label>
            <Input
              id="pos-upi"
              value={cart.upi}
              onChange={(e) => update({ upi: e.target.value })}
              placeholder="0"
              maxLength={16}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="pos-card">Card (₹)</Label>
            <Input
              id="pos-card"
              value={cart.card}
              onChange={(e) => update({ card: e.target.value })}
              placeholder="0"
              maxLength={16}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="pos-reference">Ref / Note</Label>
            <Input
              id="pos-reference"
              value={cart.reference}
              onChange={(e) => update({ reference: e.target.value })}
              maxLength={100}
            />
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-1 text-sm border-t pt-2" aria-label="Payment summary">
          <dt>Change to give</dt>
          <dd className="text-right tabular-nums">{formatPaise(Math.max(0, change))}</dd>
          <dt>On account</dt>
          <dd className="text-right tabular-nums">{formatPaise(Math.max(0, onCredit))}</dd>
        </dl>

        <Button
          type="button"
          size="lg"
          onClick={save}
          disabled={pending || bill === null || preview.problem !== null || !paymentsValid || needsCustomer}
          className="mt-1"
        >
          {pending ? "Saving…" : "Save bill (F9)"}
        </Button>

        {saveHint !== null && (
          <p className="text-xs text-muted-foreground">
            {saveHint}
          </p>
        )}
      </aside>
    </div>
  );
}
