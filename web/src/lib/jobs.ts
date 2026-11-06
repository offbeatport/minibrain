import { useQueryClient } from "@tanstack/react-query";
import type { LogEntry } from "obp-ui";
import { useEffect, useState } from "react";
import { type JobEvent, type JobInfo, jobEventsUrl } from "~/api/client";
import { keys } from "~/api/queries";

const MAX_EVENTS = 20000;
const FLUSH_MS = 250;

const KIND_NAMES: Record<string, string> = {
    train: "Train",
    eval: "Score",
    judge: "Judge",
    download: "Download",
    import: "Import",
    verify: "Verify",
    repair: "Repair",
    catalog_sync: "Catalogue sync",
};

export const MODEL_JOB_KINDS = ["train", "eval", "judge"];

export function kindName(kind: string): string {
    return KIND_NAMES[kind] ?? kind;
}

export function jobTitle(job: JobInfo): string {
    const name = kindName(job.kind);
    return job.version === null || job.version === undefined ? name : `${name} v${job.version}`;
}

export function jobPageHref(id: number): string {
    return `/jobs/${id}`;
}

export function useInvalidate(slug: string) {
    const queryClient = useQueryClient();
    return () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: ["model", slug] }),
            queryClient.invalidateQueries({ queryKey: keys.models }),
            queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        ]);
}

export function durationText(seconds: number): string {
    if (seconds < 60) {
        return `${Math.round(seconds)} s`;
    }
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

export function jobDuration(job: JobInfo): string {
    const seconds = jobSeconds(job);
    return seconds < 0 ? "—" : durationText(seconds);
}

export function jobSeconds(job: JobInfo): number {
    if (!job.started_at) {
        return -1;
    }
    const end = job.finished_at ? new Date(job.finished_at).getTime() : Date.now();
    return Math.max(0, (end - new Date(job.started_at).getTime()) / 1000);
}

function sentence(text: string): string {
    return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export function logEntry(event: JobEvent): LogEntry {
    const { traceback, ...fields } = event.data ?? {};
    const structured = event.kind === "event" && Object.keys(fields).length > 0;
    return {
        id: event.id,
        time: Date.parse(event.at),
        level: event.level,
        source: event.source,
        message: event.kind === "state" ? sentence(event.message) : event.message,
        fields: structured ? fields : undefined,
        detail: typeof traceback === "string" ? traceback : undefined,
    };
}

export function useJobEvents(jobId: number): LogEntry[] {
    const [entries, setEntries] = useState<LogEntry[]>([]);
    useEffect(() => {
        setEntries([]);
        let pending: LogEntry[] = [];
        let seen = 0;
        const flush = () => {
            if (pending.length === 0) {
                return;
            }
            const arrived = pending;
            pending = [];
            setEntries((previous) => [...previous, ...arrived].slice(-MAX_EVENTS));
        };
        const source = new EventSource(jobEventsUrl(jobId));
        source.onmessage = (message) => {
            const event = JSON.parse(message.data) as JobEvent;
            if (event.id > seen) {
                seen = event.id;
                pending.push(logEntry(event));
            }
        };
        source.addEventListener("end", () => {
            flush();
            source.close();
        });
        const timer = window.setInterval(flush, FLUSH_MS);
        return () => {
            window.clearInterval(timer);
            source.close();
        };
    }, [jobId]);
    return entries;
}
