import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import "./scalar.css";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Button, Link, TabNav, type TabNavItem, getTheme, onThemeChange } from "obp-ui";
import { type ComponentProps, useMemo, useSyncExternalStore } from "react";
import { usePerson } from "~/api/authQueries";
import { type ModelRow, api, unwrap, withCsrf } from "~/api/client";
import { useAllModels } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page } from "~/components/Section";
import { ROLE_LABELS, useCan } from "~/lib/access";
import { API_REFERENCE_PATH, MANAGEMENT_REFERENCE_PATH } from "~/lib/modelLinks";
import {
    type ApiDocument,
    CSRF_PLACEHOLDER,
    gatewayDocument,
    managementDocument,
} from "./documents";

type Kind = "gateway" | "management";
type Configuration = ComponentProps<typeof ApiReferenceReact>["configuration"];
type HiddenClients = Extract<Configuration, { hiddenClients?: unknown }>["hiddenClients"];

const TABS: TabNavItem[] = [
    { label: "OpenAI-compatible API", href: API_REFERENCE_PATH },
    { label: "Management API", href: MANAGEMENT_REFERENCE_PATH },
];

const CAPTIONS: Record<Kind, string> = {
    gateway: "Call models from your apps with an API key: models, chat completions and feedback.",
    management: "Automate minibrain itself: data, models, training, deployments and settings.",
};

const SOURCES = { gateway: "/api/openapi/v1.json", management: "/api/openapi/api.json" } as const;

const MANAGEMENT_CLIENTS: HiddenClients = {
    c: true,
    clojure: true,
    csharp: true,
    dart: true,
    fsharp: true,
    go: true,
    http: true,
    java: true,
    julia: true,
    kotlin: true,
    node: true,
    objc: true,
    ocaml: true,
    php: true,
    powershell: true,
    r: true,
    ruby: true,
    rust: true,
    swift: true,
    shell: ["httpie", "wget"],
    python: ["aiohttp", "httpx_sync", "httpx_async", "python3"],
    js: ["axios", "jquery", "ofetch", "xhr"],
};

const AUTHENTICATION = {
    gateway: { preferredSecurityScheme: "apiKey" },
    management: {
        preferredSecurityScheme: "csrf",
        securitySchemes: { csrf: { value: CSRF_PLACEHOLDER } },
    },
};

function referenceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const session = url.origin === window.location.origin && url.pathname.startsWith("/api/");
    return fetch(session ? withCsrf(request) : request);
}

function deployedNames(rows: ModelRow[] | undefined): string[] {
    return (rows ?? [])
        .filter((row) => row.deployment.state !== "not_deployed")
        .map((row) => row.key);
}

function useSource(kind: Kind) {
    return useQuery({
        queryKey: ["api-reference", kind],
        queryFn: async () => (await unwrap(api.GET(SOURCES[kind]))) as unknown as ApiDocument,
        staleTime: Number.POSITIVE_INFINITY,
    });
}

function useDocument(kind: Kind): { document: ApiDocument | null; error: unknown } {
    const source = useSource(kind);
    const models = useAllModels();
    const role = usePerson()?.role;
    const origin = window.location.origin;
    const names = useMemo(() => deployedNames(models.data), [models.data]);
    const document = useMemo(() => {
        if (!source.data || (kind === "gateway" && models.isPending)) {
            return null;
        }
        return kind === "gateway"
            ? gatewayDocument(source.data, origin, names)
            : managementDocument(
                  source.data,
                  origin,
                  role ? ROLE_LABELS[role] : "a person with no role",
              );
    }, [kind, source.data, models.isPending, origin, names, role]);
    return { document, error: source.error };
}

function Reference({ kind, document }: { kind: Kind; document: ApiDocument }) {
    const theme = useSyncExternalStore(onThemeChange, getTheme);
    const configuration = useMemo<Configuration>(
        () => ({
            content: document,
            theme: "none",
            layout: "modern",
            withDefaultFonts: false,
            telemetry: false,
            showDeveloperTools: "never",
            hideClientButton: true,
            hideDarkModeToggle: true,
            forceDarkModeState: theme,
            mcp: { disabled: true },
            agent: { disabled: true },
            persistAuth: false,
            documentDownloadType: "json",
            defaultOpenAllTags: kind === "gateway",
            orderSchemaPropertiesBy: "preserve",
            modelsSectionLabel: "Schemas",
            hiddenClients: kind === "gateway" ? true : MANAGEMENT_CLIENTS,
            customFetch: referenceFetch,
            authentication: AUTHENTICATION[kind],
        }),
        [kind, document, theme],
    );
    return (
        <div className="api-reference overflow-clip rounded-xl border">
            <ApiReferenceReact configuration={configuration} />
        </div>
    );
}

export function ApiReferencePage() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const kind: Kind = pathname === MANAGEMENT_REFERENCE_PATH ? "management" : "gateway";
    const can = useCan();
    const { document, error } = useDocument(kind);
    return (
        <Page wide>
            <PageHeader
                title="API reference"
                caption={CAPTIONS[kind]}
                actions={
                    kind === "gateway" &&
                    can.build && (
                        <Button variant="outline" asChild>
                            <Link href="/models">Create a key</Link>
                        </Button>
                    )
                }
            />
            <TabNav label="API reference pages" tabs={TABS} />
            <ErrorLine error={error} />
            {document && <Reference key={kind} kind={kind} document={document} />}
        </Page>
    );
}
