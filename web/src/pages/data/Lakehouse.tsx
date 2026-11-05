import {
    Button,
    Field,
    FileTypeIcon,
    InfoTip,
    Input,
    Label,
    Link,
    RadioGroup,
    RadioGroupItem,
} from "obp-ui";
import { useState } from "react";
import {
    type DatasetSummary,
    type SourceAdded,
    type SourceSummary,
    api,
    unwrap,
} from "~/api/client";
import { EXTENSIONS_FOR, useConnections } from "~/api/connectionQueries";
import { Stat } from "~/components/Section";
import { count } from "~/lib/format";
import {
    AddDialog,
    ConnectionPicker,
    ExtensionWarning,
    NameField,
    firstId,
    usable,
    useAddSource,
} from "./Connected";
import { TABLE_FORMATS, type TableFormat, tableFormat, usesSource } from "./catalogue";
import { useSourceNameProblem } from "./parts";

const FORMAT_ORDER: TableFormat[] = ["iceberg", "delta"];

const DESCRIPTIONS: Record<TableFormat, string> = {
    iceberg:
        "minibrain reads the table's newest metadata from S3 and queries its current snapshot in place. Each dataset version saved here copies the rows.",
    delta: "minibrain reads the table's newest version from its _delta_log and queries it in place. Each dataset version saved here copies the rows.",
};

const NOT_FIPS_READY =
    "DuckDB's delta extension reads a table's log with its own HTTP and TLS client (delta-kernel-rs with rustls and ring), outside OpenSSL, so reading it from S3 or HTTPS is not FIPS-ready. Mount the bucket on this server instead. Iceberg tables on S3 go through OpenSSL.";

function FormatPicker({
    value,
    onChange,
}: {
    value: TableFormat;
    onChange: (value: TableFormat) => void;
}) {
    return (
        <div className="flex flex-col gap-label">
            <Label asChild>
                <span id="lakehouse-format">Table format</span>
            </Label>
            <RadioGroup
                value={value}
                onValueChange={(next) => onChange(next === "delta" ? "delta" : "iceberg")}
                className="flex flex-wrap gap-4"
                aria-labelledby="lakehouse-format"
            >
                {FORMAT_ORDER.map((format) => (
                    <Label key={format} className="flex items-center gap-2 font-normal">
                        <RadioGroupItem value={format} />
                        <FileTypeIcon type={format} className="size-4" />
                        {TABLE_FORMATS[format].label}
                    </Label>
                ))}
            </RadioGroup>
        </div>
    );
}

function Missing({ children, href, action }: { children: string; href: string; action: string }) {
    return (
        <p className="text-sm text-muted-foreground">
            {`${children} `}
            <Link href={href} className="text-primary hover:underline">
                {action}
            </Link>
        </p>
    );
}

export function AddLakehouseDialog({
    open,
    roots,
    onOpenChange,
    onAdded,
}: {
    open: boolean;
    roots: string[];
    onOpenChange: (open: boolean) => void;
    onAdded: (source: SourceAdded) => void;
}) {
    const connections = useConnections();
    const options = usable(connections.data, "s3");
    const [format, setFormat] = useState<TableFormat>("iceberg");
    const [connection, setConnection] = useState<number | null>(null);
    const [s3Path, setS3Path] = useState("");
    const [folder, setFolder] = useState("");
    const [name, setName] = useState("");
    const chosen = connection ?? firstId(options);
    const bucket = options.find((item) => item.id === chosen)?.bucket;
    const add = useAddSource(
        () =>
            format === "iceberg"
                ? unwrap(
                      api.POST("/api/sources/iceberg", {
                          body: {
                              connection_id: chosen ?? 0,
                              path: s3Path.trim(),
                              name: name.trim() || null,
                          },
                      }),
                  )
                : unwrap(
                      api.POST("/api/sources/delta", {
                          body: { path: folder.trim(), name: name.trim() || null },
                      }),
                  ),
        onAdded,
        onOpenChange,
    );
    const nameProblem = useSourceNameProblem(name);
    const ready =
        !nameProblem &&
        (format === "iceberg"
            ? chosen !== null && s3Path.trim().startsWith("s3://")
            : roots.length > 0 && folder.trim().length > 0);
    const pick = (next: TableFormat) => {
        setFormat(next);
        add.reset();
    };
    return (
        <AddDialog
            open={open}
            title="Add a Lakehouse table"
            description={DESCRIPTIONS[format]}
            pending={add.isPending}
            ready={ready}
            submitLabel="Add table"
            error={add.error}
            onOpenChange={onOpenChange}
            onSubmit={() => add.mutate()}
        >
            <FormatPicker value={format} onChange={pick} />
            {format === "iceberg" ? (
                connections.data && options.length === 0 ? (
                    <Missing href="/settings/connections" action="Open connections">
                        Iceberg tables are read from S3 through a connection, and there is none yet.
                    </Missing>
                ) : (
                    <>
                        <ConnectionPicker
                            id="lakehouse-connection"
                            options={options}
                            value={chosen}
                            onChange={setConnection}
                        />
                        <Field
                            id="lakehouse-path"
                            label="Table folder"
                            hint="The folder that holds the table's metadata and data folders."
                        >
                            <Input
                                id="lakehouse-path"
                                value={s3Path}
                                className="font-mono"
                                placeholder={`s3://${bucket || "lake"}/warehouse/sales/orders`}
                                onChange={(event) => setS3Path(event.target.value)}
                            />
                        </Field>
                    </>
                )
            ) : roots.length === 0 ? (
                <Missing href="/settings/security" action="Open security settings">
                    Delta tables are read from folders an admin allows under Settings, Security,
                    Folder sources, and there are none yet.
                </Missing>
            ) : (
                <Field
                    id="lakehouse-folder"
                    label="Table folder on this server"
                    hint={
                        <>
                            {`The folder that holds _delta_log, inside ${roots.join(", ")}. Local or mounted folders only, not S3.`}
                            <InfoTip
                                label="Why Delta tables are not read from S3"
                                side="bottom"
                                className="ml-1 align-text-bottom"
                            >
                                {NOT_FIPS_READY}
                            </InfoTip>
                        </>
                    }
                >
                    <Input
                        id="lakehouse-folder"
                        value={folder}
                        className="font-mono"
                        placeholder={`${roots[0] ?? "/srv/lake"}/sales/orders`}
                        onChange={(event) => setFolder(event.target.value)}
                    />
                </Field>
            )}
            <NameField value={name} problem={nameProblem} onChange={setName} />
            <ExtensionWarning needed={EXTENSIONS_FOR[format] ?? []} />
        </AddDialog>
    );
}

export function LakehouseGroup({
    sources,
    datasets,
    onAdd,
}: {
    sources: SourceSummary[];
    datasets: DatasetSummary[];
    onAdd: () => void;
}) {
    const members = sources.filter((source) => tableFormat(source.kind) !== null);
    const built = datasets.filter((dataset) =>
        members.some((source) => usesSource(dataset, source.id)),
    );
    const used = FORMAT_ORDER.filter((format) => members.some((source) => source.kind === format));
    return (
        <div className="flex flex-col gap-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="text-2xl font-semibold">Lakehouse</h2>
                    <p className="text-sm text-muted-foreground">
                        Iceberg and Delta Lake tables, read in place at their current snapshot or
                        version. Iceberg tables come from S3 through a connection, Delta tables from
                        folders on this server.
                    </p>
                </div>
                <Button onClick={onAdd}>Add table</Button>
            </header>
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Tables" value={count(members.length)} />
                {FORMAT_ORDER.map((format) => (
                    <Stat
                        key={format}
                        label={TABLE_FORMATS[format].label}
                        value={count(members.filter((source) => source.kind === format).length)}
                    />
                ))}
                <Stat label="Datasets" value={count(built.length)} />
            </div>
            <ExtensionWarning needed={used.flatMap((format) => EXTENSIONS_FOR[format] ?? [])} />
            <p className="text-sm text-muted-foreground">
                {members.length === 0
                    ? "No tables yet. Each one becomes a table in dataset SQL."
                    : "Pick a table to see its columns, rows and the version or snapshot it is read at."}
            </p>
        </div>
    );
}

export function LakehouseFacts({ source }: { source: SourceSummary }) {
    const format = tableFormat(source.kind);
    if (!format) {
        return null;
    }
    return (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Format</dt>
            <dd className="flex items-center gap-2">
                <FileTypeIcon type={format} className="size-4" />
                {TABLE_FORMATS[format].label}
            </dd>
            {format === "iceberg" && (
                <>
                    <dt className="text-muted-foreground">Connection</dt>
                    <dd>
                        <Link href="/settings/connections" className="text-primary hover:underline">
                            {source.connection ?? "Missing"}
                        </Link>
                    </dd>
                </>
            )}
            <dt className="text-muted-foreground">
                {format === "iceberg" ? "Path" : "Folder on this server"}
            </dt>
            <dd className="font-mono break-all">{source.path}</dd>
            <dt className="text-muted-foreground">Changes</dt>
            <dd>{source.fingerprint_detail ?? "Not read yet"}</dd>
            {source.fingerprint && (
                <>
                    <dt className="text-muted-foreground">Fingerprint</dt>
                    <dd className="font-mono break-all text-muted-foreground">
                        {source.fingerprint.slice(0, 16)}
                    </dd>
                </>
            )}
        </dl>
    );
}
