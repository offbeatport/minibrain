import { type MachinePlan, type PlanInfo, gigabytes } from "./recipe";

export type PoolPlan = {
    name: string;
    label: string;
    machines: MachinePlan[];
    best: MachinePlan | null;
    reason: string;
};

function minutesOf(machine: MachinePlan): number {
    return machine.minutes ?? Number.POSITIVE_INFINITY;
}

function quickest(machines: MachinePlan[]): MachinePlan | null {
    return machines
        .filter((item) => item.chosen)
        .reduce<MachinePlan | null>(
            (best, item) => (best === null || minutesOf(item) < minutesOf(best) ? item : best),
            null,
        );
}

function largest(machines: MachinePlan[]): MachinePlan | null {
    return machines
        .filter((item) => item.available_bytes)
        .reduce<MachinePlan | null>(
            (best, item) =>
                best === null || (item.available_bytes ?? 0) > (best.available_bytes ?? 0)
                    ? item
                    : best,
            null,
        );
}

function refusal(machines: MachinePlan[]): string {
    const biggest = largest(machines);
    if (!biggest) {
        return "memory not reported yet";
    }
    if (!biggest.smallest) {
        return "does not fit";
    }
    return `does not fit · needs ${gigabytes(biggest.smallest.peak_bytes)} of ${gigabytes(biggest.available_bytes)}`;
}

export function poolsOf(plan: PlanInfo | undefined): PoolPlan[] {
    const groups = new Map<string, MachinePlan[]>();
    for (const machine of plan?.machines ?? []) {
        groups.set(machine.pool, [...(groups.get(machine.pool) ?? []), machine]);
    }
    return [...groups.entries()].map(([name, machines]) => ({
        name,
        label: machines[0]?.pool_label ?? name,
        machines,
        best: quickest(machines),
        reason: refusal(machines),
    }));
}
