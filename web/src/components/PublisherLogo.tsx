import { type ProviderId, ProviderLogo } from "obp-ui";
import type { ReactNode } from "react";
import { ModelName, withDeleted } from "./ModelName";

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

export function PublisherLogo({
    publisher,
    name,
    size = "md",
}: {
    publisher?: string | null;
    name: string;
    size?: keyof typeof SIZES;
}) {
    const id = publisher ? PROVIDERS[publisher] : undefined;
    const { tile, logo } = SIZES[size];
    return (
        <span
            aria-hidden="true"
            className={`flex ${tile} shrink-0 items-center justify-center rounded-md border bg-background`}
        >
            {id ? (
                <ProviderLogo id={id} className={logo} />
            ) : (
                <span className="text-sm font-semibold text-muted-foreground">
                    {name.trim().charAt(0).toUpperCase()}
                </span>
            )}
        </span>
    );
}

export function ModelLabel({
    publisher,
    name,
    label,
    detail,
}: {
    publisher?: string | null;
    name: string;
    label?: ReactNode;
    detail?: ReactNode;
}) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <PublisherLogo publisher={publisher} name={name} size="sm" />
            <span className="flex min-w-0 flex-col">
                <span className="truncate">{label ?? name}</span>
                {detail && <span className="truncate text-sm opacity-70">{detail}</span>}
            </span>
        </span>
    );
}

export function modelOption<
    T extends { label: string; publisher?: string | null; deleted?: boolean },
>(option: T) {
    return {
        ...option,
        label: (
            <ModelLabel
                publisher={option.publisher}
                name={option.label}
                label={<ModelName name={option.label} deleted={option.deleted} />}
            />
        ),
        text: withDeleted(option.label, option.deleted),
    };
}
