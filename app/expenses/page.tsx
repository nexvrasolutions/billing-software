"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPaise, rupeesToPaise } from "@/lib/money";

interface ExpenseItem {
    id: string;
    expenseDate: string;
    categoryName: string;
    amount: number;
    paymentMethod: string;
    note?: string;
}

const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm";

const DEFAULT_CATEGORIES = ["Rent", "Salaries", "Electricity", "Internet & Phone", "Repairs & Maintenance", "Tea & Refreshments", "Other"];

export default function ExpensesPage() {
    const today = new Date().toISOString().slice(0, 10);
    const firstOfMonth = `${today.slice(0, 8)}01`;

    const [from, setFrom] = useState(firstOfMonth);
    const [to, setTo] = useState(today);
    const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
    const [expenses, setExpenses] = useState<ExpenseItem[]>([
        {
            id: "exp-1",
            expenseDate: today,
            categoryName: "Tea & Refreshments",
            amount: 150,
            paymentMethod: "Cash",
            note: "Staff refreshments",
        },
    ]);

    // Form fields
    const [cat, setCat] = useState(DEFAULT_CATEGORIES[0]);
    const [amount, setAmount] = useState("");
    const [method, setMethod] = useState("Cash");
    const [note, setNote] = useState("");
    const [newCatName, setNewCatName] = useState("");

    const total = expenses.reduce((s, r) => s + r.amount, 0);
    const byCategory = new Map<string, number>();
    for (const r of expenses) {
        byCategory.set(r.categoryName, (byCategory.get(r.categoryName) ?? 0) + r.amount);
    }

    function handleRecordExpense(e: React.FormEvent) {
        e.preventDefault();
        const amt = Number(amount);
        if (!amt || amt <= 0) return;

        const newExp: ExpenseItem = {
            id: `exp-${Date.now()}`,
            expenseDate: today,
            categoryName: cat,
            amount: amt,
            paymentMethod: method,
            note: note.trim() || undefined,
        };

        setExpenses([newExp, ...expenses]);
        setAmount("");
        setNote("");
    }

    function handleAddCategory(e: React.FormEvent) {
        e.preventDefault();
        if (!newCatName.trim()) return;
        if (!categories.includes(newCatName.trim())) {
            setCategories([...categories, newCatName.trim()]);
            setCat(newCatName.trim());
        }
        setNewCatName("");
    }

    return (
        <AppShell>
            <main className="flex max-w-4xl flex-col gap-4">
                <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>

                <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1 text-sm">
                        From
                        <input
                            type="date"
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        To
                        <input
                            type="date"
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                        />
                    </label>
                    <button type="button" className="h-8 rounded-lg border px-3 text-sm">
                        Show
                    </button>
                </div>

                <section className="flex flex-col gap-1 text-sm" aria-label="Expense totals">
                    <p className="font-medium">
                        Total {from} to {to}: {formatPaise(rupeesToPaise(total))}
                    </p>
                    {[...byCategory].map(([name, sum]) => (
                        <p key={name} className="text-muted-foreground">
                            {name}: {formatPaise(rupeesToPaise(sum))}
                        </p>
                    ))}
                </section>

                <div className="table-scroll">
                    <table className="w-full text-sm" aria-label="Expenses table">
                        <thead className="border-b bg-muted/40 text-left">
                            <tr>
                                <th className="p-2 font-medium">Date</th>
                                <th className="p-2 font-medium">Category</th>
                                <th className="p-2 text-right font-medium">Amount</th>
                                <th className="p-2 font-medium">Method</th>
                                <th className="p-2 font-medium">Note</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {expenses.map((e) => (
                                <tr key={e.id}>
                                    <td className="p-2">{e.expenseDate}</td>
                                    <td className="p-2 font-medium">{e.categoryName}</td>
                                    <td className="p-2 text-right tabular-nums">
                                        {formatPaise(rupeesToPaise(e.amount))}
                                    </td>
                                    <td className="p-2">{e.paymentMethod}</td>
                                    <td className="p-2 text-muted-foreground">{e.note || "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* Record expense form */}
                <section className="flex flex-col gap-3 rounded-lg border p-4">
                    <h2 className="text-base font-semibold">Record expense</h2>
                    <form onSubmit={handleRecordExpense} className="flex flex-col gap-3">
                        <div className="flex flex-wrap gap-3">
                            <div className="flex flex-col gap-1">
                                <Label htmlFor="exp-cat">Category</Label>
                                <select
                                    id="exp-cat"
                                    value={cat}
                                    onChange={(e) => setCat(e.target.value)}
                                    className={selectClass}
                                >
                                    {categories.map((c) => (
                                        <option key={c} value={c}>
                                            {c}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex flex-col gap-1">
                                <Label htmlFor="exp-amount">Amount (₹)</Label>
                                <Input
                                    id="exp-amount"
                                    value={amount}
                                    onChange={(e) => setAmount(e.target.value)}
                                    required
                                    inputMode="decimal"
                                    placeholder="0.00"
                                    className="w-32"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <Label htmlFor="exp-method">Payment method</Label>
                                <select
                                    id="exp-method"
                                    value={method}
                                    onChange={(e) => setMethod(e.target.value)}
                                    className={selectClass}
                                >
                                    <option value="Cash">Cash</option>
                                    <option value="UPI">UPI</option>
                                    <option value="Card">Card</option>
                                    <option value="Bank">Bank transfer</option>
                                </select>
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <Label htmlFor="exp-note">Note (optional)</Label>
                            <Input
                                id="exp-note"
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder="What was this for?"
                                className="max-w-md"
                            />
                        </div>

                        <Button type="submit" className="self-start">
                            Record expense
                        </Button>
                    </form>
                </section>
            </main>
        </AppShell>
    );
}
