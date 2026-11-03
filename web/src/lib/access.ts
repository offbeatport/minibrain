import { type Role, usePerson } from "~/api/authQueries";

const RANK: Record<Role, number> = { viewer: 1, builder: 2, admin: 3 };

export const ROLE_LABELS: Record<Role, string> = {
    viewer: "Viewer",
    builder: "Builder",
    admin: "Admin",
};

export const SOURCE_LABELS: Record<string, string> = {
    local: "Password",
    oidc: "Single sign-on",
    proxy: "Proxy",
};

export function allows(role: Role | null | undefined, needed: Role): boolean {
    return role != null && RANK[role] >= RANK[needed];
}

export type Abilities = { view: boolean; build: boolean; admin: boolean };

export function useCan(): Abilities {
    const role = usePerson()?.role ?? null;
    return {
        view: allows(role, "viewer"),
        build: allows(role, "builder"),
        admin: allows(role, "admin"),
    };
}

export function initialOf(name: string): string {
    return (name.trim()[0] ?? "?").toUpperCase();
}
