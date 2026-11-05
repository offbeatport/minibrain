import { useQuery } from "@tanstack/react-query";
import { useToast } from "obp-ui";
import { useEffect, useRef } from "react";
import { usePerson } from "~/api/authQueries";
import type { ModelRow } from "~/api/client";
import { MODELS_POLL_MS, keys, loadAllModels } from "~/api/queries";
import { busyTearingDown, outcomeOf, rowId } from "~/lib/teardown";

export function TeardownToasts() {
    const person = usePerson();
    const toast = useRef(useToast());
    const tracked = useRef(new Map<string, ModelRow>());
    const me = person ? (person.email ?? person.name) : null;
    const models = useQuery({
        queryKey: keys.allModels,
        queryFn: loadAllModels,
        enabled: me !== null,
        refetchInterval: (query) =>
            query.state.data?.some(busyTearingDown) ? MODELS_POLL_MS : false,
    });
    useEffect(() => {
        const rows = models.data;
        if (!rows) {
            return;
        }
        const current = new Map(rows.map((row) => [rowId(row), row]));
        for (const [id, before] of tracked.current) {
            const outcome = outcomeOf(before, current.get(id));
            if (outcome) {
                toast.current(outcome);
            }
        }
        tracked.current = new Map(
            rows
                .filter((row) => busyTearingDown(row) && row.teardown?.started_by === me)
                .map((row) => [rowId(row), row]),
        );
    }, [models.data, me]);
    return null;
}
