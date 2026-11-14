import { type ProviderId, ProviderLogo } from "obp-ui";
import type { ReactNode } from "react";
import type { ModelAvatar as Avatar } from "~/api/client";
import { ModelName, withDeleted } from "./ModelName";
import { ModelAvatar, useCustomModel } from "./avatar/ModelAvatar";

const PROVIDERS: Record<string, ProviderId> = {
    Qwen: "qwen",
    Google: "google",
    Meta: "meta",
    "Mistral AI": "mistral",
    Microsoft: "microsoft",
    IBM: "ibm",
    NVIDIA: "nvidia",
    DeepSeek: "deepseek",
    OpenAI: "openai",
    "Allen AI": "ai2",
    "Hugging Face": "huggingface",
    "Z.ai": "zai",
};

const SIZES = {
    sm: { tile: "size-5", logo: "size-3.5" },
    md: { tile: "size-8", logo: "size-5" },
    lg: { tile: "size-12", logo: "size-7" },
};

type Size = keyof typeof SIZES;

export function providerOf(publisher?: string | null): ProviderId | undefined {
    return publisher ? PROVIDERS[publisher] : undefined;
}

function LetterTile({ name, size }: { name: string; size: Size }) {
    return (
        <span
            aria-hidden="true"
            className={`flex ${SIZES[size].tile} shrink-0 items-center justify-center rounded-md border bg-background`}
        >
            <span className="text-sm font-semibold text-muted-foreground">
                {name.trim().charAt(0).toUpperCase()}
            </span>
        </span>
    );
}

function FoundModel({ name, modelKey, size }: { name: string; modelKey?: string; size: Size }) {
    const custom = useCustomModel(name, modelKey);
    return custom ? (
        <ModelAvatar name={custom.name} avatar={custom.avatar} size={size} />
    ) : (
        <LetterTile name={name} size={size} />
    );
}

export function PublisherLogo({
    publisher,
    name,
    size = "md",
    custom,
    avatar,
    modelKey,
}: {
    publisher?: string | null;
    name: string;
    size?: Size;
    custom?: boolean;
    avatar?: Avatar | null;
    modelKey?: string;
}) {
    if (custom) {
        return <ModelAvatar name={name} avatar={avatar} size={size} />;
    }
    const id = providerOf(publisher);
    if (id) {
        const { tile, logo } = SIZES[size];
        return (
            <span
                aria-hidden="true"
                className={`flex ${tile} shrink-0 items-center justify-center rounded-md border bg-background`}
            >
                <ProviderLogo id={id} className={logo} />
            </span>
        );
    }
    if (publisher) {
        return <LetterTile name={name} size={size} />;
    }
    return <FoundModel name={name} modelKey={modelKey} size={size} />;
}

export function ModelLabel({
    publisher,
    name,
    modelKey,
    label,
    detail,
}: {
    publisher?: string | null;
    name: string;
    modelKey?: string;
    label?: ReactNode;
    detail?: ReactNode;
}) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <PublisherLogo publisher={publisher} name={name} modelKey={modelKey} size="sm" />
            <span className="flex min-w-0 flex-col">
                <span className="truncate">{label ?? name}</span>
                {detail && <span className="truncate text-sm opacity-70">{detail}</span>}
            </span>
        </span>
    );
}

export function modelOption<
    T extends { label: string; value?: string; publisher?: string | null; deleted?: boolean },
>(option: T) {
    return {
        ...option,
        label: (
            <ModelLabel
                publisher={option.publisher}
                name={option.label}
                modelKey={option.value}
                label={<ModelName name={option.label} deleted={option.deleted} />}
            />
        ),
        text: withDeleted(option.label, option.deleted),
    };
}
