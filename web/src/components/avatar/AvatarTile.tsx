import { cn } from "obp-ui";
import { useLayoutEffect, useMemo, useRef } from "react";
import { styleById } from "./avatarStyles";
import { type AvatarChoice, avatarSvg, useDicebear } from "./avatarSvg";
import { usePalette } from "./palette";

export type AvatarSize = "sm" | "md" | "lg" | "xl" | "hero" | "fill";

const AVATAR_TILE: Record<AvatarSize, string> = {
    sm: "size-5",
    md: "size-8",
    lg: "size-12",
    xl: "size-24",
    hero: "size-[calc(3rem*var(--hero-scale))] rounded-[calc((var(--radius)_-_2px)*var(--hero-scale))] border-[length:calc(1px*var(--hero-scale))]",
    fill: "size-full",
};

const AVATAR_PX: Record<AvatarSize, number> = {
    sm: 20,
    md: 32,
    lg: 48,
    xl: 96,
    hero: 120,
    fill: 40,
};

export function SvgMarkup({ markup }: { markup: string }) {
    const host = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        host.current?.replaceChildren(svg);
    }, [markup]);
    return <span ref={host} className="flex size-full" />;
}

function useAvatarSvg(choice: AvatarChoice, name: string, px: number): string {
    const current = usePalette();
    const { style, seed, tone, letters } = choice;
    const renderer = useDicebear(styleById(style).seeded);
    return useMemo(
        () => avatarSvg({ style, seed, tone, letters }, name, current, px, renderer),
        [style, seed, tone, letters, name, current, px, renderer],
    );
}

export function AvatarTile({
    choice,
    name,
    size,
    className,
}: {
    choice: AvatarChoice;
    name: string;
    size: AvatarSize;
    className?: string;
}) {
    const markup = useAvatarSvg(choice, name, AVATAR_PX[size]);
    return (
        <span
            aria-hidden="true"
            className={cn(
                "flex shrink-0 overflow-hidden rounded-md border bg-background",
                AVATAR_TILE[size],
                className,
            )}
        >
            <SvgMarkup markup={markup} />
        </span>
    );
}
