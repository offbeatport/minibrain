import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Outlet, getRouteApi, useRouter } from "@tanstack/react-router";
import { ConfirmDialog, TabNav } from "obp-ui";
import { Button } from "obp-ui";
import { api, succeed } from "~/api/client";
import { keys, useMinibrain } from "~/api/queries";
import { ErrorLine } from "~/components/Section";

const route = getRouteApi("/m/$slug");

export function useSlug(): string {
    return route.useParams().slug;
}

export function MinibrainLayout() {
    const slug = useSlug();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { data, error } = useMinibrain(slug);
    const remove = useMutation({
        mutationFn: () =>
            succeed(api.DELETE("/api/minibrains/{slug}", { params: { path: { slug } } })),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: keys.minibrains });
            router.history.push("/");
        },
    });
    const base = `/m/${slug}`;
    const serving =
        data?.current_version === null ? "no version yet" : `serving v${data?.current_version}`;
    return (
        <div className="flex flex-col">
            <header className="border-b px-6 pt-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h1 className="truncate text-xl font-semibold">{data?.name ?? slug}</h1>
                        <p className="text-sm text-muted-foreground">
                            Classify · base <span className="font-mono">{data?.base_model}</span> ·{" "}
                            {serving}
                        </p>
                    </div>
                    <ConfirmDialog
                        trigger={
                            <Button variant="ghost" size="sm">
                                Delete
                            </Button>
                        }
                        title={`Delete ${data?.name ?? slug}?`}
                        description="This removes its data, versions, adapters and API keys from this install."
                        confirmLabel="Delete"
                        destructive
                        onConfirm={() => remove.mutateAsync()}
                    />
                </div>
                <ErrorLine error={error ?? remove.error} />
                <TabNav
                    className="mt-3"
                    tabs={[
                        { href: `${base}/data`, label: "Data" },
                        { href: `${base}/versions`, label: "Versions" },
                        { href: `${base}/playground`, label: "Playground" },
                        { href: `${base}/endpoint`, label: "Endpoint" },
                    ]}
                />
            </header>
            <Outlet />
        </div>
    );
}
