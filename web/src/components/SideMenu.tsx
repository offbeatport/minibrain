import type { LucideIcon } from "lucide-react";
import { NavItem } from "obp-ui/shell";
import type { ReactNode } from "react";

export type SideMenuItem = { label: string; href: string; icon: LucideIcon };

export function SideMenuLayout({
    label,
    items,
    active,
    children,
}: {
    label: string;
    items: SideMenuItem[];
    active: string;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
            <nav
                aria-label={label}
                className="flex shrink-0 gap-1 overflow-x-auto md:sticky md:top-4 md:w-48 md:flex-col"
            >
                {items.map((item) => (
                    <NavItem
                        key={item.href}
                        icon={item.icon}
                        label={item.label}
                        href={item.href}
                        active={item.href === active}
                        collapsed={false}
                        iconStyle="plain"
                    />
                ))}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
        </div>
    );
}
