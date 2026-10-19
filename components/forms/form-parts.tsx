"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface AuthCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function AuthCard({
  title,
  description,
  children,
  footer,
  className,
}: AuthCardProps) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-muted/30 p-4 sm:p-6 lg:p-8">
      <div
        className={cn(
          "w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm flex flex-col gap-5",
          className
        )}
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 mb-1">
            <span
              aria-hidden="true"
              className="grid size-8 place-items-center rounded-lg bg-primary font-semibold text-primary-foreground text-sm"
            >
              ₹
            </span>
            <span className="font-semibold text-base tracking-tight">Billing</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {children}
        {footer && (
          <div className="border-t border-border pt-3 text-xs text-muted-foreground">
            {footer}
          </div>
        )}
      </div>
    </main>
  );
}

export interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  error?: string | null;
  helperText?: string;
  containerClassName?: string;
}

export function Field({
  id,
  label,
  error,
  helperText,
  className,
  containerClassName,
  ...inputProps
}: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", containerClassName)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className={className}
        aria-invalid={Boolean(error)}
        {...inputProps}
      />
      {error && (
        <p className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      )}
      {helperText && !error && (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      )}
    </div>
  );
}

export interface FormMessageProps {
  kind?: "error" | "success" | "warning" | "info";
  text?: string | null;
  className?: string;
}

export function FormMessage({
  kind = "error",
  text,
  className,
}: FormMessageProps) {
  if (!text) return null;

  const kindStyles = {
    error: "border-destructive/50 bg-destructive/10 text-destructive",
    success:
      "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    warning:
      "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    info: "border-primary/30 bg-primary/5 text-foreground",
  };

  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border p-2.5 text-xs font-medium",
        kindStyles[kind],
        className
      )}
    >
      {text}
    </div>
  );
}
