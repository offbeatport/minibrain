import { useSyncExternalStore } from "react";

export type Role = "viewer" | "builder" | "admin";

type Overlays = { train: string | null; role: Role };

let overlays: Overlays = { train: null, role: "builder" };
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

export function openTrain(slug: string) {
    change({ train: slug });
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
