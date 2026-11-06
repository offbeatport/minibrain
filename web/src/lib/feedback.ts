import type { FeedbackInfo, FeedbackStatus } from "~/api/feedbackQueries";

type Variant = "approval" | "success" | "warning";

export const FEEDBACK_PATH = "/feedback";
export const FEEDBACK_STATUSES: FeedbackStatus[] = ["pending", "accepted", "rejected"];

const STATUS: Record<FeedbackStatus, { label: string; variant: Variant }> = {
    pending: { label: "To review", variant: "approval" },
    accepted: { label: "Accepted", variant: "success" },
    rejected: { label: "Rejected", variant: "warning" },
};

const SIGNALS: Record<FeedbackInfo["signal"], string | null> = {
    conflict: "People disagree",
    unsure: "No right answer given",
    none: null,
};

const ORIGINS: Record<string, string> = { api: "API", playground: "Playground" };

export function feedbackStatusLabel(status: FeedbackStatus): string {
    return STATUS[status].label;
}

export function feedbackStatusVariant(status: FeedbackStatus): Variant {
    return STATUS[status].variant;
}

export function signalLabel(signal: FeedbackInfo["signal"]): string | null {
    return SIGNALS[signal];
}

export function originLabel(origin: string): string {
    return ORIGINS[origin] ?? origin;
}

export function fromLabel(item: FeedbackInfo): string {
    return item.held_out ? "Playground test example" : originLabel(item.origin);
}

export function ratingLabel(rating: FeedbackInfo["rating"]): string {
    return rating === "up" ? "Marked right" : "Marked wrong";
}

export function feedbackHref(id: number): string {
    return `${FEEDBACK_PATH}?item=${id}`;
}

export function feedbackForModel(slug: string): string {
    return `${FEEDBACK_PATH}?model=${encodeURIComponent(slug)}`;
}
