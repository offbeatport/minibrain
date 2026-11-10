import { useSyncExternalStore } from "react";

export type VersionRef = { slug: string; number: number };

export type Role = "viewer" | "builder" | "admin";

type Overlays = { version: VersionRef | null; train: string | null; role: Role };

let overlays: Overlays = { version: null, train: null, role: "builder" };
const listeners = new Set<() => void>();

function change(next: Partial<Overlays>) {
    overlays = { ...overlays, ...next };
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useOverlays(): Overlays {
    return useSyncExternalStore(subscribe, () => overlays);
}

export function openVersion(slug: string, number: number) {
    change({ version: { slug, number } });
}

export function closeVersion() {
    change({ version: null });
}

export function openTrain(slug: string) {
    change({ train: slug, version: null });
}

export function closeTrain() {
    change({ train: null });
}

export function setRole(role: Role) {
    change({ role });
}

const RANK: Record<Role, number> = { viewer: 0, builder: 1, admin: 2 };

export function allows(role: Role, needed: Role): boolean {
    return RANK[role] >= RANK[needed];
}

export function useCan(needed: Role): boolean {
    return allows(useOverlays().role, needed);
}
