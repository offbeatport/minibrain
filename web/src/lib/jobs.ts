import { useQueryClient } from "@tanstack/react-query";
import type { LogLineData } from "obp-ui/console";
import { useEffect, useState } from "react";
import { type JobInfo, jobEventsUrl } from "~/api/client";
import { keys } from "~/api/queries";

const MAX_LOG_LINES = 300;

export function useInvalidate(slug: string) {
    const queryClient = useQueryClient();
    return () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: ["minibrain", slug] }),
            queryClient.invalidateQueries({ queryKey: keys.minibrains }),
            queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        ]);
}

export function describeLine(raw: string): LogLineData {
    try {
        const entry = JSON.parse(raw) as Record<string, unknown>;
        if (typeof entry.step === "number") {
            const loss = typeof entry.loss === "number" ? ` · loss ${entry.loss.toFixed(3)}` : "";
            return { msg: `step ${entry.step}/${entry.steps}${loss}`, kind: "info" };
        }
        if (typeof entry.evaluated === "number") {
            return { msg: `scored ${entry.evaluated}/${entry.of}`, kind: "info" };
        }
        return { msg: raw, kind: "ok" };
    } catch {
        const kind = /error|traceback/i.test(raw) ? "error" : /warn/i.test(raw) ? "warn" : "msg";
        return { msg: raw, kind };
    }
}

type JobEvent = { id: number; kind: string; message: string };

function eventLine(event: JobEvent): string | null {
    if (event.kind === "log") {
        return event.message;
    }
    return event.kind === "state" ? `· ${event.message}` : null;
}

export function useJobLog(job: JobInfo): string[] {
    const [lines, setLines] = useState<string[]>([]);
    useEffect(() => {
        setLines([]);
        const source = new EventSource(jobEventsUrl(job.id));
        source.onmessage = (message) => {
            const line = eventLine(JSON.parse(message.data) as JobEvent);
            if (line !== null) {
                setLines((previous) => [...previous, line].slice(-MAX_LOG_LINES));
            }
        };
        source.addEventListener("end", () => source.close());
        return () => source.close();
    }, [job.id]);
    return lines;
}
