import { parseFiniteNumber } from "@/lib/validations/product";

export class CsvParseError extends Error {
    line: number;
    column: number;

    constructor(message: string, line: number, column: number) {
        super(`CSV parse error at line ${line}, column ${column}: ${message}`);
        this.name = "CsvParseError";
        this.line = line;
        this.column = column;
    }
}

export interface ParsedProductRow {
    name: string;
    SKU: string;
    purchasePrice: number;
    sellingPrice: number;
    barcode?: string;
    openingStock?: number;
    rowNumber?: number;
}

export interface ParseProductCsvResult {
    success: boolean;
    rows: ParsedProductRow[];
    errors: string[];
}

/**
 * Deterministically constructs an operation ID for a CSV import row.
 * Scoped to an import batch ID and normalized SKU.
 */
export function getCsvRowOperationId(batchId: string, sku: string): string {
    const trimmedBatch = batchId.trim();
    const normalizedSku = sku.trim().toUpperCase();
    return `csv-import:${trimmedBatch}:${normalizedSku}`;
}

/**
 * Robust RFC 4180-compliant CSV parser.
 * Supports:
 * - Quoted fields containing commas
 * - Escaped double quotes ("" -> ")
 * - Quoted fields containing CRLF and LF newlines
 * - Mixed CRLF and LF line endings
 * - Empty fields and trailing empty columns
 * - Strict syntax error reporting for unclosed quotes and stray characters
 */
export function parseCsv(input: string): string[][] {
    if (!input || input.length === 0) {
        return [];
    }

    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = "";
    let inQuotes = false;
    let afterQuote = false;
    let fieldStarted = false;

    let line = 1;
    let col = 0;
    let quoteStartLine = 1;
    let quoteStartCol = 1;

    let i = 0;
    const len = input.length;

    while (i < len) {
        const char = input[i];
        col++;

        // Case 1: Inside quoted field
        if (inQuotes) {
            if (char === '"') {
                // Escaped double-quote ("")
                if (i + 1 < len && input[i + 1] === '"') {
                    currentField += '"';
                    i += 2;
                    col++;
                    continue;
                }
                // Closing quote
                inQuotes = false;
                afterQuote = true;
                i++;
                continue;
            }

            if (char === "\n") {
                currentField += "\n";
                line++;
                col = 0;
                i++;
                continue;
            }

            if (char === "\r") {
                if (i + 1 < len && input[i + 1] === "\n") {
                    currentField += "\n";
                    i += 2;
                } else {
                    currentField += "\r";
                    i++;
                }
                line++;
                col = 0;
                continue;
            }

            currentField += char;
            i++;
            continue;
        }

        // Case 2: Immediately after closing quote
        if (afterQuote) {
            if (char === " " || char === "\t") {
                // Allow whitespace between closing quote and delimiter/newline
                i++;
                continue;
            }

            if (char === ",") {
                currentRow.push(currentField);
                currentField = "";
                afterQuote = false;
                fieldStarted = false;
                i++;
                continue;
            }

            if (char === "\r" || char === "\n") {
                if (char === "\r" && i + 1 < len && input[i + 1] === "\n") {
                    i++;
                }
                currentRow.push(currentField);
                rows.push(currentRow);
                currentRow = [];
                currentField = "";
                afterQuote = false;
                fieldStarted = false;
                line++;
                col = 0;
                i++;
                continue;
            }

            throw new CsvParseError(
                `Unexpected character '${char}' after closing quote`,
                line,
                col
            );
        }

        // Case 3: Outside quotes
        if (!fieldStarted && (char === " " || char === "\t")) {
            // Check if leading whitespace precedes a quote
            let peekIndex = i;
            while (peekIndex < len && (input[peekIndex] === " " || input[peekIndex] === "\t")) {
                peekIndex++;
            }
            if (peekIndex < len && input[peekIndex] === '"') {
                // Skip leading whitespace to start quoted field
                col += peekIndex - i - 1;
                i = peekIndex;
                continue;
            }
        }

        if (char === '"') {
            if (!fieldStarted) {
                inQuotes = true;
                fieldStarted = true;
                quoteStartLine = line;
                quoteStartCol = col;
                i++;
                continue;
            } else {
                throw new CsvParseError(
                    "Unexpected quote character inside unquoted field",
                    line,
                    col
                );
            }
        }

        if (char === ",") {
            currentRow.push(currentField.trim());
            currentField = "";
            fieldStarted = false;
            i++;
            continue;
        }

        if (char === "\r" || char === "\n") {
            if (char === "\r" && i + 1 < len && input[i + 1] === "\n") {
                i++;
            }
            // Skip entirely empty blank lines between records
            if (currentRow.length > 0 || fieldStarted || currentField.length > 0) {
                currentRow.push(currentField.trim());
                rows.push(currentRow);
            }
            currentRow = [];
            currentField = "";
            fieldStarted = false;
            line++;
            col = 0;
            i++;
            continue;
        }

        currentField += char;
        fieldStarted = true;
        i++;
    }

    if (inQuotes) {
        throw new CsvParseError(
            "Unclosed quoted field",
            quoteStartLine,
            quoteStartCol
        );
    }

    if (afterQuote || fieldStarted || currentRow.length > 0) {
        currentRow.push(afterQuote ? currentField : currentField.trim());
        rows.push(currentRow);
    }

    return rows;
}

/**
 * Parse and validate product CSV content.
 * Guarantees that prices are finite non-negative numbers and never converts
 * malformed strings or non-finite values to zero.
 */
export function parseProductCsv(csvText: string): ParseProductCsvResult {
    let rawGrid: string[][];
    try {
        rawGrid = parseCsv(csvText);
    } catch (err) {
        return {
            success: false,
            rows: [],
            errors: [err instanceof Error ? err.message : String(err)],
        };
    }

    // Filter out rows that are entirely empty or whitespace
    const nonBlankRows = rawGrid.filter((row) =>
        row.some((cell) => cell !== undefined && cell.trim().length > 0)
    );

    if (nonBlankRows.length < 2) {
        return {
            success: false,
            rows: [],
            errors: ["Please provide a CSV header and at least one product row."],
        };
    }

    const header = nonBlankRows[0].map((h) => h.trim().toLowerCase());
    const nameIdx = header.indexOf("name");
    const skuIdx = header.indexOf("sku");
    const buyIdx = header.findIndex(
        (h) => h.includes("purchase") || h.includes("buy") || h === "purchaseprice" || h === "cost"
    );
    const sellIdx = header.findIndex(
        (h) => h.includes("sell") || h.includes("sellingprice") || h === "price"
    );
    const barcodeIdx = header.indexOf("barcode");
    const stockIdx = header.findIndex(
        (h) =>
            h === "openingstock" ||
            h === "initialstock" ||
            h === "stock" ||
            h === "quantity" ||
            h === "qty" ||
            h === "opening_stock"
    );

    if (nameIdx === -1 || skuIdx === -1 || sellIdx === -1) {
        return {
            success: false,
            rows: [],
            errors: ["CSV header must include at least: name, SKU, sellingPrice"],
        };
    }

    const rows: ParsedProductRow[] = [];
    const errors: string[] = [];
    const seenSkus = new Map<string, number>();

    for (let r = 1; r < nonBlankRows.length; r++) {
        const row = nonBlankRows[r];
        const rowNum = r + 1; // 1-indexed for user display

        const name = (row[nameIdx] || "").trim();
        const rawSku = (row[skuIdx] || "").trim();
        const rawSelling = row[sellIdx] !== undefined ? row[sellIdx].trim() : "";
        const rawPurchase = buyIdx !== -1 && row[buyIdx] !== undefined ? row[buyIdx].trim() : "";
        const rawBarcode = barcodeIdx !== -1 && row[barcodeIdx] !== undefined ? row[barcodeIdx].trim() : "";
        const rawStock = stockIdx !== -1 && row[stockIdx] !== undefined ? row[stockIdx].trim() : "";

        // Validate name
        if (!name) {
            errors.push(`Row ${rowNum}: Product name is required.`);
        } else if (name.length > 200) {
            errors.push(`Row ${rowNum}: Product name cannot exceed 200 characters.`);
        }

        // Validate SKU
        if (!rawSku) {
            errors.push(`Row ${rowNum}: Product SKU is required.`);
        } else if (rawSku.length > 100) {
            errors.push(`Row ${rowNum}: Product SKU cannot exceed 100 characters.`);
        } else {
            const normalizedSku = rawSku.toUpperCase();
            const firstSeenRow = seenSkus.get(normalizedSku);
            if (firstSeenRow !== undefined) {
                errors.push(
                    `Row ${rowNum}: Duplicate SKU "${normalizedSku}" already appears on row ${firstSeenRow}. Duplicate SKUs within one CSV file are not permitted.`
                );
            } else {
                seenSkus.set(normalizedSku, rowNum);
            }
        }

        // Validate sellingPrice: must be present and a non-negative finite number
        let sellingPrice = 0;
        if (!rawSelling) {
            errors.push(`Row ${rowNum}: Selling price is required.`);
        } else {
            const parsedSelling = parseFiniteNumber(rawSelling);
            if (parsedSelling === null || parsedSelling < 0) {
                errors.push(`Row ${rowNum}: Invalid selling price "${rawSelling}". Must be a valid non-negative number.`);
            } else {
                sellingPrice = parsedSelling;
            }
        }

        // Validate purchasePrice: optional, but if provided must be a non-negative finite number
        let purchasePrice = 0;
        if (rawPurchase) {
            const parsedPurchase = parseFiniteNumber(rawPurchase);
            if (parsedPurchase === null || parsedPurchase < 0) {
                errors.push(`Row ${rowNum}: Invalid purchase price "${rawPurchase}". Must be a valid non-negative number.`);
            } else {
                purchasePrice = parsedPurchase;
            }
        }

        // Validate openingStock: optional (defaults to 0 if missing/empty), but if supplied must be a non-negative finite number
        let openingStock = 0;
        if (rawStock) {
            const parsedStock = parseFiniteNumber(rawStock);
            if (parsedStock === null || parsedStock < 0) {
                errors.push(`Row ${rowNum}: Invalid opening stock "${rawStock}". Must be a valid non-negative number.`);
            } else {
                openingStock = parsedStock;
            }
        }

        const barcode = rawBarcode ? rawBarcode.toUpperCase() : undefined;

        if (name && rawSku && rawSelling && !errors.some((e) => e.startsWith(`Row ${rowNum}:`))) {
            rows.push({
                name,
                SKU: rawSku.toUpperCase(),
                purchasePrice,
                sellingPrice,
                barcode,
                openingStock,
                rowNumber: rowNum,
            });
        }
    }

    if (errors.length > 0) {
        return {
            success: false,
            rows: [],
            errors,
        };
    }

    if (rows.length === 0) {
        return {
            success: false,
            rows: [],
            errors: ["No valid product rows could be parsed from the CSV input."],
        };
    }

    return {
        success: true,
        rows,
        errors: [],
    };
}
