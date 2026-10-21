"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType, type ReactNode } from "react";

export interface NavLink {
  href: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

export interface NavGroup {
  title: string;
  links: NavLink[];
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppNav(props: {
  groups: NavGroup[];
  roleName?: string;
  businessName?: string;
  footer?: ReactNode;
}): ReactNode {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const close = (): void => {
    setOpen(false);
  };

  const business = props.businessName || "Billing";
  const role = props.roleName || "User";

  return (
    <>
      {/* Phone top bar (the page header on small screens) */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur lg:hidden print:hidden">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 font-semibold"
          onClick={close}
        >
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-foreground"
          >
            ₹
          </span>
          <span className="truncate max-w-[180px]">{business}</span>
        </Link>
        <button
          type="button"
          className="inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium"
          aria-expanded={open}
          aria-controls="app-menu"
          onClick={() => {
            setOpen(!open);
          }}
        >
          <span aria-hidden="true">{open ? "✕" : "☰"}</span>
          {open ? "Close" : "Menu"}
        </button>
      </header>

      {/* Main navigation drawer on phone / fixed sidebar on wide screens */}
      <div
        id="app-menu"
        className={`${open
          ? "fixed inset-x-0 top-[57px] bottom-0 z-30 overflow-y-auto bg-background"
          : "hidden"
          } border-r bg-sidebar lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-60 lg:shrink-0 lg:flex-col print:hidden`}
      >
        {/* The page header on wide screens: the app and the person's role. */}
        <header className="hidden items-center gap-2 px-4 pt-5 pb-3 lg:flex">
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-lg bg-primary font-semibold text-primary-foreground"
          >
            ₹
          </span>
          <div className="min-w-0">
            <Link
              href="/dashboard"
              className="block truncate text-base leading-tight font-semibold"
            >
              {business}
            </Link>
            <p className="truncate text-xs text-muted-foreground">{role}</p>
          </div>
        </header>

        <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 lg:py-2">
          {props.groups.map((group) => (
            <div key={group.title} className="flex flex-col gap-0.5">
              <p className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.title}
              </p>
              {group.links.map((link) => {
                const active = isActive(pathname, link.href);

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={close}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors lg:py-1.5 ${active
                      ? "bg-primary/10 font-medium text-primary"
                      : "hover:bg-muted"
                      }`}
                  >

                    <span>{link.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="flex flex-col gap-2 border-t px-4 py-3">
          <span className="text-xs text-muted-foreground lg:hidden">{role}</span>
          {props.footer}
        </div>
      </div>
    </>
  );
}
