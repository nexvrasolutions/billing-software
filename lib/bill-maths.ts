// Bill maths. Pure and exact: integer paise, BigInt inside, never floating point.
// The same function runs in the browser (cart preview) and on the server.

const QTY = /^(\d{1,11})(?:\.(\d{1,3}))?$/;
const RATE = /^(\d{1,3})(?:\.(\d{1,4}))?$/;
const MAX_PAISE = 100_000_000_000; // ₹100 crore per bill

const B_0 = BigInt(0);
const B_1 = BigInt(1);
const B_2 = BigInt(2);
const B_100 = BigInt(100);
const B_1000 = BigInt(1000);
const B_10000 = BigInt(10000);
const RATE_ONE = BigInt(1000000); // 100% in ten-thousandths of a percent

export class BillMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillMathError";
  }
}

export interface BillLineInput {
  quantity: string; // "2", "1.5" (at most 3 decimals)
  unitPricePaise: number; // the product's price, as the business sets prices
  taxRate?: string; // GST %, e.g. "5", "18", "0", or undefined if unconfigured
  discountPaise: number; // this line's own discount, in paise
}

export interface BillInput {
  lines: BillLineInput[];
  pricesIncludeTax: boolean;
  chargesGst: boolean; // false: composition or unregistered (bill of supply)
  interState: boolean; // the buyer is in another state: IGST
  billDiscountPaise: number; // a discount on the whole bill, in paise
  roundOff: boolean;
}

export interface BillLineResult {
  grossPaise: number;
  lineDiscountPaise: number;
  billDiscountPaise: number; // this line's share of the bill discount
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
}

export interface BillResult {
  lines: BillLineResult[];
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number; // before round-off
  roundOffPaise: number; // -49 ... +50
  payablePaise: number;
}

export function quantityToMilli(quantity: string): bigint {
  const match = QTY.exec(quantity);
  if (match === null) throw new BillMathError("Enter a quantity with at most 3 decimals.");
  return BigInt(match[1] ?? "0") * B_1000 + BigInt((match[2] ?? "").padEnd(3, "0"));
}

export function rateToE4(rate?: string): bigint {
  if (rate === undefined || rate === null || rate.trim() === "") {
    throw new BillMathError("Tax rate is not configured. Configure product tax rate before billing.");
  }
  const match = RATE.exec(rate);
  if (match === null) throw new BillMathError("Enter a GST rate, e.g. 5 or 18.");
  const value = BigInt(match[1] ?? "0") * B_10000 + BigInt((match[2] ?? "").padEnd(4, "0"));
  if (value > RATE_ONE) throw new BillMathError("A GST rate cannot be above 100%.");
  return value;
}

// a / b rounded half up, for a >= 0 and b > 0.
const divRound = (a: bigint, b: bigint): bigint => (B_2 * a + b) / (B_2 * b);

const paise = (value: number, what: string): bigint => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PAISE) throw new BillMathError(`${what}: enter a whole number of paise.`);
  return BigInt(value);
};

// Splits `total` paise over lines in proportion to `weights`, exactly:
// every line gets its share rounded down, then the paise left over go one at
// a time to the lines with the largest leftover fractions (ties: the larger
// line, then the earlier line). No share is ever below 0 or above its weight.
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, B_0);
  if (total === B_0) return weights.map(() => B_0);
  if (total < B_0 || total > sum) throw new BillMathError("The bill discount cannot be more than the bill.");
  const shares = weights.map((w) => (total * w) / sum);
  let left = total - shares.reduce((a, b) => a + b, B_0);
  const order = weights
    .map((w, i) => ({ i, w, remainder: (total * w) % sum }))
    .sort((a, b) => (a.remainder !== b.remainder ? (b.remainder > a.remainder ? 1 : -1) : a.w !== b.w ? (b.w > a.w ? 1 : -1) : a.i - b.i));
  for (const { i } of order) {
    if (left === B_0) break;
    shares[i] = (shares[i] ?? B_0) + B_1;
    left -= B_1;
  }
  return shares;
}

export function computeBill(input: BillInput): BillResult {
  if (input.lines.length === 0) throw new BillMathError("Add at least one item.");
  if (input.lines.length > 500) throw new BillMathError("A bill can have at most 500 lines.");

  const prepared = input.lines.map((line, index) => {
    const milli = quantityToMilli(line.quantity);
    if (milli === B_0) throw new BillMathError(`Line ${String(index + 1)}: enter a quantity above zero.`);
    const gross = divRound(milli * paise(line.unitPricePaise, "Price"), B_1000);
    const lineDiscount = paise(line.discountPaise, "Discount");
    if (lineDiscount > gross) throw new BillMathError(`Line ${String(index + 1)}: the discount is more than the line.`);
    if (input.chargesGst && (line.taxRate === undefined || line.taxRate === null || line.taxRate.trim() === "")) {
      throw new BillMathError(`Line ${String(index + 1)}: tax rate is not configured. Configure product tax rate before billing.`);
    }
    return { gross, lineDiscount, rate: input.chargesGst ? rateToE4(line.taxRate) : B_0 };
  });
  const shares = allocate(
    paise(input.billDiscountPaise, "Bill discount"),
    prepared.map((p) => p.gross - p.lineDiscount),
  );

  const lines = prepared.map((p, i): BillLineResult => {
    const share = shares[i] ?? B_0;
    const amount = p.gross - p.lineDiscount - share;
    let taxable = amount;
    let cgst = B_0;
    let igst = B_0;
    if (p.rate > B_0) {
      if (input.pricesIncludeTax) {
        const net = divRound(amount * RATE_ONE, RATE_ONE + p.rate);
        if (input.interState) {
          taxable = net;
          igst = amount - net;
        } else {
          cgst = divRound(net * p.rate, B_2 * RATE_ONE);
          taxable = amount - B_2 * cgst;
        }
      } else if (input.interState) {
        igst = divRound(amount * p.rate, RATE_ONE);
      } else {
        cgst = divRound(amount * p.rate, B_2 * RATE_ONE);
      }
    }
    const tax = B_2 * cgst + igst;
    return {
      grossPaise: Number(p.gross),
      lineDiscountPaise: Number(p.lineDiscount),
      billDiscountPaise: Number(share),
      taxablePaise: Number(taxable),
      cgstPaise: Number(cgst),
      sgstPaise: Number(cgst),
      igstPaise: Number(igst),
      taxPaise: Number(tax),
      totalPaise: Number(taxable + tax),
    };
  });

  const sum = (pick: (l: BillLineResult) => number): number => lines.reduce((s, l) => s + pick(l), 0);
  const total = sum((l) => l.totalPaise);
  if (total > MAX_PAISE) throw new BillMathError("This bill total is too large.");
  const roundOff = input.roundOff ? Number(divRound(BigInt(total), B_100) * B_100) - total : 0;
  return {
    lines,
    grossPaise: sum((l) => l.grossPaise),
    discountPaise: sum((l) => l.lineDiscountPaise + l.billDiscountPaise),
    taxablePaise: sum((l) => l.taxablePaise),
    cgstPaise: sum((l) => l.cgstPaise),
    sgstPaise: sum((l) => l.sgstPaise),
    igstPaise: sum((l) => l.igstPaise),
    taxPaise: sum((l) => l.taxPaise),
    totalPaise: total,
    roundOffPaise: roundOff,
    payablePaise: total + roundOff,
  };
}

export function discountWithinLimit(bill: BillResult, limitBps: number | null): boolean {
  if (limitBps === null) return true;
  const limit = BigInt(limitBps);
  const within = (discount: number, gross: number): boolean => BigInt(discount) * B_10000 <= BigInt(gross) * limit;
  return within(bill.discountPaise, bill.grossPaise) && bill.lines.every((l) => within(l.lineDiscountPaise, l.grossPaise));
}

export interface CalculateSaleLineInput {
  productId?: string;
  name?: string;
  SKU?: string;
  quantity: number | string;
  unitPrice: number; // in rupees
  discountRate?: number; // 0 to 100
  discountAmount?: number; // in rupees
  taxRate?: number | string; // 0 to 100, or string "0", "18", or undefined/null
}

export interface CalculateSaleInput {
  lines: CalculateSaleLineInput[];
  pricingMode: "tax_inclusive" | "tax_exclusive";
  chargesGst?: boolean; // defaults to true
  interState?: boolean; // defaults to false
  billDiscountPaise?: number; // defaults to 0
  roundOff?: boolean; // defaults to false
}

export interface CalculateSaleLineResult {
  grossAmount: number; // Rupees
  discountAmount: number; // Rupees
  taxableAmount: number; // Rupees
  taxRate: number; // Percentage
  taxAmount: number; // Rupees
  lineTotal: number; // Rupees
}

export interface CalculateSaleResult {
  lines: CalculateSaleLineResult[];
  subtotal: number;
  discountTotal: number;
  taxableTotal: number;
  taxTotal: number;
  roundOff: number;
  grandTotal: number;
}

export function calculateSale(input: CalculateSaleInput): CalculateSaleResult {
  if (input.pricingMode !== "tax_inclusive" && input.pricingMode !== "tax_exclusive") {
    throw new BillMathError("Invalid pricing mode. Must be 'tax_inclusive' or 'tax_exclusive'.");
  }

  const billLines: BillLineInput[] = input.lines.map((line, index) => {
    const qtyStr =
      typeof line.quantity === "number"
        ? (Number.isFinite(line.quantity) && line.quantity > 0
            ? line.quantity.toFixed(3).replace(/\.?0+$/, "") || "0"
            : String(line.quantity))
        : String(line.quantity ?? "");

    const unitPricePaise =
      typeof line.unitPrice === "number" && Number.isFinite(line.unitPrice) && line.unitPrice >= 0
        ? Math.round(line.unitPrice * 100)
        : -1;
    if (unitPricePaise < 0) {
      throw new BillMathError(`Line ${index + 1}: enter a valid unit price.`);
    }

    const taxRateStr =
      line.taxRate !== undefined && line.taxRate !== null && String(line.taxRate).trim() !== ""
        ? String(line.taxRate).trim()
        : undefined;

    let discountPaise = 0;
    if (line.discountAmount !== undefined && line.discountAmount !== null) {
      if (typeof line.discountAmount !== "number" || !Number.isFinite(line.discountAmount) || line.discountAmount < 0) {
        throw new BillMathError(`Line ${index + 1}: enter a valid discount amount.`);
      }
      discountPaise = Math.round(line.discountAmount * 100);
    } else if (line.discountRate !== undefined && line.discountRate !== null && line.discountRate > 0) {
      if (typeof line.discountRate !== "number" || !Number.isFinite(line.discountRate) || line.discountRate < 0 || line.discountRate > 100) {
        throw new BillMathError(`Line ${index + 1}: enter a discount rate between 0 and 100.`);
      }
      const milli = quantityToMilli(qtyStr);
      const grossPaise = divRound(milli * BigInt(unitPricePaise), B_1000);
      const rateE4 = BigInt(Math.round(line.discountRate * 10000));
      discountPaise = Number(divRound(grossPaise * rateE4, RATE_ONE));
    }

    return {
      quantity: qtyStr,
      unitPricePaise,
      taxRate: taxRateStr,
      discountPaise,
    };
  });

  const bill = computeBill({
    lines: billLines,
    pricesIncludeTax: input.pricingMode === "tax_inclusive",
    chargesGst: input.chargesGst ?? true,
    interState: input.interState ?? false,
    billDiscountPaise: input.billDiscountPaise ?? 0,
    roundOff: input.roundOff ?? false,
  });

  const lines: CalculateSaleLineResult[] = bill.lines.map((l, i) => {
    const rawTaxRate = billLines[i]?.taxRate;
    return {
      grossAmount: Number((l.grossPaise / 100).toFixed(2)),
      discountAmount: Number(((l.lineDiscountPaise + l.billDiscountPaise) / 100).toFixed(2)),
      taxableAmount: Number((l.taxablePaise / 100).toFixed(2)),
      taxRate: rawTaxRate !== undefined ? Number(rawTaxRate) : 0,
      taxAmount: Number((l.taxPaise / 100).toFixed(2)),
      lineTotal: Number((l.totalPaise / 100).toFixed(2)),
    };
  });

  return {
    lines,
    subtotal: Number((bill.grossPaise / 100).toFixed(2)),
    discountTotal: Number((bill.discountPaise / 100).toFixed(2)),
    taxableTotal: Number((bill.taxablePaise / 100).toFixed(2)),
    taxTotal: Number((bill.taxPaise / 100).toFixed(2)),
    roundOff: Number((bill.roundOffPaise / 100).toFixed(2)),
    grandTotal: Number((bill.payablePaise / 100).toFixed(2)),
  };
}

