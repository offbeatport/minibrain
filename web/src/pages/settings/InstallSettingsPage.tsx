import { useQuery } from "@tanstack/react-query";
import { BookMarked, Cpu, FolderTree, Globe, Package, Radar, Server } from "lucide-react";
import {
    Badge,
    Button,
    InfoTip,
    Link,
    SettingsGroup,
    SettingsRow,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import type { ReactNode } from "react";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { CopyButton } from "~/components/CopyButton";
import { ErrorLine, PanelSection, PanelSections } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { SoftwareMark } from "~/components/SoftwareMark";
import { count } from "~/lib/format";
import { bytes, exactTime, relativeTime } from "~/lib/time";

type InstallInfo = components["schemas"]["InstallInfo"];
type Network = components["schemas"]["InstallNetwork"];

const DIAGNOSTICS = "/api/system/diagnostics";
const SHORT_COMMIT = 12;
const SHORT_PATH = 48;

const NETWORK_MODES: Record<Network["mode"], [string, string]> = {
    offline: ["Off", "minibrain makes no outbound calls."],
    allowlist: ["Allowlist", "Only the allowed hosts are reached."],
    open: ["Open", "Any host the features below need can be reached."],
};

const LOCK_SOURCES: Record<string, string> = {
    environment: "Set by environment",
    "config file": "Set by config file",
};

function Muted({ children }: { children: ReactNode }) {
    return <span className="text-sm text-muted-foreground">{children}</span>;
}

function Text({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
    return <span className={cn("text-sm tabular-nums", mono && "font-mono")}>{children}</span>;
}

function shortPath(value: string): string {
    return value.length > SHORT_PATH ? `…${value.slice(-(SHORT_PATH - 1))}` : value;
}

function Path({ value, label }: { value: string; label: string }) {
    return (
        <div className="flex min-w-0 items-center gap-1">
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="max-w-[min(28rem,60vw)] truncate font-mono text-sm">
                        {shortPath(value)}
                    </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-md break-all">{value}</TooltipContent>
            </Tooltip>
            <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
        </div>
    );
}

function Row({
    label,
    description,
    children,
}: {
    label: string;
    description?: ReactNode;
    children: ReactNode;
}) {
    return <SettingsRow label={label} description={description} control={children} />;
}

function SoftwareRow({
    label,
    mark,
    fallback,
    description,
    children,
}: {
    label: string;
    mark: string;
    fallback?: ReactNode;
    description?: ReactNode;
    children: ReactNode;
}) {
    return (
        <SettingsRow
            label={
                <span className="flex items-center gap-2.5">
                    <SoftwareMark name={mark} fallback={fallback} />
                    {label}
                </span>
            }
            description={description}
            control={children}
        />
    );
}

function version(value: string | null | undefined): ReactNode {
    return value ? <Text>{value}</Text> : <Muted>Not installed</Muted>;
}

function versionsText(info: InstallInfo): string {
    const software = info.software;
    const build = software.commit ? ` (build ${software.commit.slice(0, SHORT_COMMIT)})` : "";
    return [
        `minibrain ${software.minibrain}${build}`,
        `Python ${software.python}`,
        `DuckDB ${software.duckdb ?? "not installed"}`,
        `PyTorch ${software.torch ?? "not installed"}`,
        `Transformers ${software.transformers ?? "not installed"}`,
        `${software.system}, ${software.arch}`,
    ].join("\n");
}

function Software({ info }: { info: InstallInfo }) {
    const software = info.software;
    return (
        <PanelSection
            icon={Package}
            title="Software"
            actions={<CopyButton value={versionsText(info)} label="Copy versions" />}
        >
            <SettingsGroup>
                <SoftwareRow label="minibrain" mark="minibrain">
                    <Text>{software.minibrain}</Text>
                </SoftwareRow>
                <SoftwareRow
                    label="Build"
                    mark="git"
                    description={
                        software.commit ? "The commit this install was built from." : undefined
                    }
                >
                    {software.commit ? (
                        <div className="flex items-center gap-1">
                            <Text mono>{software.commit.slice(0, SHORT_COMMIT)}</Text>
                            <CopyButton value={software.commit} label="Copy commit" />
                        </div>
                    ) : (
                        <Muted>Not recorded</Muted>
                    )}
                </SoftwareRow>
                <SoftwareRow label="Python" mark="python">
                    {version(software.python)}
                </SoftwareRow>
                <SoftwareRow label="DuckDB" mark="duckdb">
                    {version(software.duckdb)}
                </SoftwareRow>
                <SoftwareRow label="PyTorch" mark="pytorch">
                    {version(software.torch)}
                </SoftwareRow>
                <SoftwareRow label="Transformers" mark="transformers">
                    {version(software.transformers)}
                </SoftwareRow>
                <SoftwareRow label="Operating system" mark={software.system}>
                    <Text>{software.system}</Text>
                </SoftwareRow>
                <SoftwareRow
                    label="Architecture"
                    mark="cpu"
                    fallback={<Cpu className="text-muted-foreground" />}
                >
                    <Text>{software.arch}</Text>
                </SoftwareRow>
            </SettingsGroup>
        </PanelSection>
    );
}

function webDescription(places: InstallInfo["places"]): string {
    if (places.web_url) {
        return `Served from ${places.web_url} while developing.`;
    }
    if (!places.web_built_at) {
        return "No build found in this folder.";
    }
    const bundle = places.web_bundle ? `, ${places.web_bundle}` : "";
    return `Built ${relativeTime(places.web_built_at)}${bundle}`;
}

function Locations({ info }: { info: InstallInfo }) {
    const places = info.places;
    const sqlite = places.database_kind === "sqlite";
    const s3 = places.storage_kind === "s3";
    return (
        <PanelSection icon={FolderTree} title="Locations">
            <SettingsGroup>
                <Row label="Server">
                    <Text>{places.host}</Text>
                </Row>
                <Row
                    label="Home folder"
                    description="Settings, secrets, the database and model files."
                >
                    <Path value={places.home} label="Home folder" />
                </Row>
                <Row
                    label="Database"
                    description={
                        sqlite
                            ? `SQLite, ${bytes(places.database_bytes)}`
                            : "PostgreSQL. The address is shown without its password."
                    }
                >
                    <Path value={places.database_location} label="Database location" />
                </Row>
                <Row
                    label="Artifact storage"
                    description={s3 ? "S3-compatible bucket" : "Local folder on this server"}
                >
                    <Path
                        value={s3 ? (places.storage_bucket ?? "") : places.storage_location}
                        label={s3 ? "Bucket" : "Artifact folder"}
                    />
                </Row>
                {s3 && places.storage_endpoint && (
                    <Row label="Storage endpoint">
                        <Path value={places.storage_endpoint} label="Storage endpoint" />
                    </Row>
                )}
                <Row label="Web UI" description={webDescription(places)}>
                    <Path value={places.web_path} label="Web UI folder" />
                </Row>
            </SettingsGroup>
        </PanelSection>
    );
}

function snapshotText(snapshot: string): string {
    return `${snapshot.replace("T", " ")} UTC`;
}

function Catalogue({ info }: { info: InstallInfo }) {
    const catalogue = info.catalogue;
    const current = catalogue.snapshot ?? catalogue.bundled_snapshot;
    return (
        <PanelSection icon={BookMarked} title="Model catalogue">
            <SettingsGroup>
                <Row
                    label="Catalogue version"
                    description={
                        current === catalogue.bundled_snapshot
                            ? "The catalogue bundled with this release."
                            : `Updated since the bundled ${snapshotText(catalogue.bundled_snapshot)}.`
                    }
                >
                    <Text>{snapshotText(current)}</Text>
                </Row>
                <Row label="Entries" description={`Model information from ${catalogue.source}.`}>
                    <Text>{count(catalogue.entries)}</Text>
                </Row>
                <Row label="Checked for updates">
                    {catalogue.synced_at ? (
                        <TimeText value={catalogue.synced_at} />
                    ) : (
                        <Muted>Never</Muted>
                    )}
                </Row>
                <Row
                    label="Model files verified"
                    description={`Last hash check across ${count(catalogue.models)} models on this install.`}
                >
                    {catalogue.models_verified_at ? (
                        <TimeText value={catalogue.models_verified_at} />
                    ) : (
                        <Muted>Never</Muted>
                    )}
                </Row>
            </SettingsGroup>
        </PanelSection>
    );
}

function TimeText({ value }: { value: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="rounded-sm text-sm tabular-nums">
                    {relativeTime(value)}
                </button>
            </TooltipTrigger>
            <TooltipContent>{exactTime(value)}</TooltipContent>
        </Tooltip>
    );
}

function Compute({ info }: { info: InstallInfo }) {
    const compute = info.compute;
    return (
        <PanelSection
            icon={Server}
            title="Compute"
            actions={
                <Button variant="outline" asChild>
                    <Link href="/infrastructure">Open Infrastructure</Link>
                </Button>
            }
        >
            <SettingsGroup>
                <Row label="Pools">
                    <Text>{count(compute.pools)}</Text>
                </Row>
                <Row label="Machines">
                    <Text>{`${count(compute.machines_online)} of ${count(compute.machines)} online`}</Text>
                </Row>
                <Row
                    label="Workers online"
                    description="Processes that run training and evaluation jobs."
                >
                    <Text>{count(compute.workers_online)}</Text>
                </Row>
                <Row
                    label="Engines online"
                    description="Model servers reporting in the last 30 seconds."
                >
                    <Text>{count(compute.engines_online)}</Text>
                </Row>
            </SettingsGroup>
        </PanelSection>
    );
}

function NetworkSection({ info }: { info: InstallInfo }) {
    const network = info.network;
    const [mode, explanation] = NETWORK_MODES[network.mode];
    const lock = LOCK_SOURCES[network.source];
    return (
        <PanelSection
            icon={Globe}
            title="Network"
            description="Where this install may connect."
            actions={
                <Button variant="outline" asChild>
                    <Link href="/settings/security">Change in Security</Link>
                </Button>
            }
        >
            <SettingsGroup>
                <Row label="Outbound access" description={explanation}>
                    <div className="flex items-center gap-2">
                        {network.locked && lock && <Badge variant="neutral">{lock}</Badge>}
                        <Text>{mode}</Text>
                    </div>
                </Row>
                {network.mode === "allowlist" && (
                    <Row label="Allowed hosts">
                        {network.allowed_hosts.length > 0 ? (
                            <Text mono>{network.allowed_hosts.join(", ")}</Text>
                        ) : (
                            <Muted>None</Muted>
                        )}
                    </Row>
                )}
                {network.endpoints.map((endpoint) => (
                    <Row
                        key={endpoint.name}
                        label={endpoint.name}
                        description={
                            <>
                                <span className="font-mono break-all">{endpoint.url}</span>
                                {!endpoint.by_policy && (
                                    <span>
                                        {" "}
                                        You configured this; the network policy does not apply.
                                    </span>
                                )}
                            </>
                        }
                    >
                        {endpoint.by_policy ? (
                            <Badge variant={endpoint.allowed ? "info" : "neutral"}>
                                {endpoint.allowed ? "Allowed" : "Blocked"}
                            </Badge>
                        ) : (
                            <Text>Always used</Text>
                        )}
                    </Row>
                ))}
                <Row
                    label="Telemetry"
                    description="No usage data, crash reports or analytics go to the minibrain developers or any third party."
                >
                    <Text>None</Text>
                </Row>
            </SettingsGroup>
        </PanelSection>
    );
}

function scrapeAccess(observability: InstallInfo["observability"]): string {
    const ways = [
        observability.metrics_token ? "a bearer token" : "",
        observability.metrics_addresses.length > 0
            ? `scrapes from ${observability.metrics_addresses.join(", ")}`
            : "",
    ].filter(Boolean);
    return `On /metrics, needing ${ways.join(" and ")}.`;
}

function Observability({ info }: { info: InstallInfo }) {
    const observability = info.observability;
    return (
        <PanelSection
            icon={Radar}
            title="Observability"
            description="Metrics, traces and logs for your own monitoring."
            actions={
                <Button variant="outline" asChild>
                    <Link href="/settings/security">OpenTelemetry in Security</Link>
                </Button>
            }
        >
            <SettingsGroup>
                <Row
                    label="OpenTelemetry export"
                    description="Traces and metrics of /v1 requests, jobs and workers, sent only to your collector."
                >
                    <Text>{observability.otlp ? "On" : "Off"}</Text>
                </Row>
                <Row
                    label="Prometheus"
                    description={
                        observability.metrics
                            ? scrapeAccess(observability)
                            : "Turn it on with metrics.addresses or metrics.token_file in minibrain.yaml, or MINIBRAIN_METRICS_TOKEN."
                    }
                >
                    <Text>{observability.metrics ? "On" : "Off"}</Text>
                </Row>
                <Row
                    label="Log format"
                    description="JSON writes one line per event to standard output. Set MINIBRAIN_LOG_FORMAT or logging.format in minibrain.yaml."
                >
                    <Text>{observability.log_format === "json" ? "JSON" : "Text"}</Text>
                </Row>
            </SettingsGroup>
        </PanelSection>
    );
}

export function InstallSettingsPage() {
    const install = useQuery({
        queryKey: ["system", "install"],
        queryFn: () => unwrap(api.GET("/api/system/install")),
    });
    const info = install.data;
    return (
        <SettingsLayout
            title="This install"
            actions={
                <>
                    <InfoTip label="What the diagnostics file holds">
                        Versions, settings, policies, job counts and recent server warnings, as a
                        zip for a support request. Secrets, tokens and passwords are left out.
                    </InfoTip>
                    <Button variant="outline" asChild>
                        <a href={DIAGNOSTICS} download>
                            Download diagnostics
                        </a>
                    </Button>
                </>
            }
        >
            <ErrorLine error={install.error} />
            {info && (
                <PanelSections>
                    <Software info={info} />
                    <Locations info={info} />
                    <Catalogue info={info} />
                    <Compute info={info} />
                    <NetworkSection info={info} />
                    <Observability info={info} />
                </PanelSections>
            )}
        </SettingsLayout>
    );
}
