import { Button } from "@/components/motion/button";
import {
    CenterMorphModal,
    CenterMorphModalClose,
    CenterMorphModalContent,
    CenterMorphModalTrigger,
} from "@/components/motion/center-morph-modal";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Outlet, getRouteApi, useRouter, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { api, succeed } from "~/api/client";
import { keys, useMinibrain } from "~/api/queries";
import { ErrorLine } from "~/components/Section";

const route = getRouteApi("/m/$slug");

const TABS = [
    { value: "data", label: "Data" },
    { value: "versions", label: "Versions" },
    { value: "playground", label: "Playground" },
    { value: "endpoint", label: "Endpoint" },
];

export function useSlug(): string {
    return route.useParams().slug;
}

function DeleteMinibrain({ slug, name }: { slug: string; name: string }) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const remove = useMutation({
        mutationFn: () =>
            succeed(api.DELETE("/api/minibrains/{slug}", { params: { path: { slug } } })),
        onSuccess: async () => {
            setOpen(false);
            await queryClient.invalidateQueries({ queryKey: keys.minibrains });
            router.history.push("/");
        },
    });
    return (
        <CenterMorphModal open={open} onOpenChange={setOpen}>
            <CenterMorphModalTrigger>
                <Button variant="ghost" size="sm">
                    Delete
                </Button>
            </CenterMorphModalTrigger>
            <CenterMorphModalContent
                ariaLabel={`Delete ${name}`}
                ariaDescribedBy="delete-description"
            >
                <div className="p-7">
                    <h2 className="pr-8 text-xl font-semibold tracking-tight">Delete {name}?</h2>
                    <p id="delete-description" className="mt-2 text-sm text-muted-foreground">
                        This removes its data, versions, adapters and API keys from this install.
                    </p>
                    <ErrorLine error={remove.error} />
                    <div className="mt-6 flex justify-end gap-2">
                        <CenterMorphModalClose>
                            <Button variant="ghost">Cancel</Button>
                        </CenterMorphModalClose>
                        <Button
                            className="bg-destructive text-white hover:bg-destructive/90"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate()}
                        >
                            Delete
                        </Button>
                    </div>
                </div>
            </CenterMorphModalContent>
        </CenterMorphModal>
    );
}

export function MinibrainLayout() {
    const slug = useSlug();
    const router = useRouter();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const { data, error } = useMinibrain(slug);
    const tab = TABS.find((item) => pathname.endsWith(`/${item.value}`))?.value ?? "data";
    const serving =
        data?.current_version === null ? "no version yet" : `serving v${data?.current_version}`;
    return (
        <div className="flex flex-col">
            <header className="border-b border-border px-6 pt-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h1 className="truncate text-2xl font-semibold tracking-tight">
                            {data?.name ?? slug}
                        </h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Classify · base <span className="font-mono">{data?.base_model}</span> ·{" "}
                            {serving}
                        </p>
                    </div>
                    <DeleteMinibrain slug={slug} name={data?.name ?? slug} />
                </div>
                <ErrorLine error={error} />
                <Tabs
                    value={tab}
                    onValueChange={(value) => router.history.push(`/m/${slug}/${value}`)}
                    variant="underline"
                    className="mt-4"
                >
                    <TabsList>
                        {TABS.map((item) => (
                            <TabsTrigger key={item.value} value={item.value}>
                                {item.label}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                </Tabs>
            </header>
            <Outlet />
        </div>
    );
}
