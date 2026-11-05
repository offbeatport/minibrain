import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { entryAt } from "~/pages/settings/settingsIndex";

const FLASH_MS = 1600;
const WAIT_MS = 6000;
const GRACE_MS = 800;
const FOCUSABLE =
    ":is(input:not([type=hidden]), button, select, textarea, [tabindex]):not([disabled], [tabindex='-1'])";

function focusControl(element: HTMLElement) {
    const control =
        element.querySelector<HTMLElement>(`[data-slot=settings-row-control] ${FOCUSABLE}`) ??
        element.querySelector<HTMLElement>(FOCUSABLE);
    control?.focus({ preventScroll: true });
}

function land(anchor: string, fallback: string | null): () => void {
    const timers: number[] = [];
    let flashed: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    const reveal = (element: HTMLElement) => {
        observer?.disconnect();
        timers.forEach(window.clearTimeout);
        element.scrollIntoView({ block: "center" });
        window.requestAnimationFrame(() => element.scrollIntoView({ block: "center" }));
        focusControl(element);
        element.setAttribute("data-flash", "");
        flashed = element;
        timers.push(window.setTimeout(() => element.removeAttribute("data-flash"), FLASH_MS));
    };
    let graceStarted = false;
    const look = () => {
        const target = document.getElementById(anchor);
        if (target) {
            reveal(target);
            return;
        }
        const section = fallback ? document.getElementById(fallback) : null;
        if (section && !graceStarted) {
            graceStarted = true;
            timers.push(
                window.setTimeout(
                    () => reveal(document.getElementById(anchor) ?? section),
                    GRACE_MS,
                ),
            );
        }
    };
    look();
    if (!flashed) {
        observer = new MutationObserver(look);
        observer.observe(document.body, { childList: true, subtree: true });
        timers.push(window.setTimeout(() => observer?.disconnect(), WAIT_MS));
    }
    return () => {
        observer?.disconnect();
        timers.forEach(window.clearTimeout);
        flashed?.removeAttribute("data-flash");
    };
}

function visitOf(state: { location: { hash: string; state: { __TSR_key?: string } } }): string {
    return `${state.location.state.__TSR_key ?? ""}#${state.location.hash}`;
}

export function useSettingsLanding() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const visit = useRouterState({ select: visitOf });
    useEffect(() => {
        const anchor = decodeURIComponent(visit.slice(visit.indexOf("#") + 1));
        if (!anchor) {
            return;
        }
        const entry = entryAt(pathname, anchor);
        return land(anchor, entry && entry.sectionAnchor !== anchor ? entry.sectionAnchor : null);
    }, [pathname, visit]);
}
