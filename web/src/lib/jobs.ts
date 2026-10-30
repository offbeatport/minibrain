import { useQueryClient } from "@tanstack/react-query";
import type { LogLineData } from "obp-ui/console";
import { useEffect, useState } from "react";
import { type JobInfo, readLog } from "~/api/client";
import { isActiveJob, keys } from "~/api/queries";

const LOG_POLL_MS = 2000;
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

export function useJobLog(job: JobInfo): string[] {
    const [lines, setLines] = useState<string[]>([]);
    const active = isActiveJob(job);
    useEffect(() => {
        let offset = 0;
        let pending = "";
        let stopped = false;
        setLines([]);
        const pull = async () => {
            const chunk = await readLog(job.id, offset);
            if (stopped || chunk.text === "") {
                return;
            }
            offset = chunk.offset;
            const parts = (pending + chunk.text).split("\n");
            pending = parts.pop() ?? "";
            setLines((previous) => [...previous, ...parts.filter(Boolean)].slice(-MAX_LOG_LINES));
        };
        pull();
        const timer = active ? window.setInterval(pull, LOG_POLL_MS) : undefined;
        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [job.id, active]);
    return lines;
}
