import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { HighlightText, SearchMenu, type SearchMenuGroup, foldText, searchTerms } from "obp-ui";
import { NavItem, useRail } from "obp-ui/shell";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePerson } from "~/api/authQueries";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { SETTINGS_PAGES, visibleTo } from "~/components/navigation";
import { allows } from "~/lib/access";
import { type IndexEntry, SETTINGS_INDEX } from "~/pages/settings/settingsIndex";

type PolicyInfo = components["schemas"]["PolicyInfo"];
type Hit = { entry: IndexEntry; score: number; order: number };

const LABEL = 100;
const LABEL_START = 20;
const SECTION = 10;
const OTHER = 1;
const SUGGESTIONS = "“retention”, “keys” or “storage”";

function usePolicies(enabled: boolean) {
    return useQuery({
        queryKey: ["policies"],
        queryFn: () => unwrap(api.GET("/api/policies")),
        enabled,
    });
}

function withServerText(entry: IndexEntry, policies: Map<string, PolicyInfo>): IndexEntry | null {
    if (!entry.policy || (entry.label && entry.description)) {
        return entry;
    }
    const policy = policies.get(entry.policy);
    if (!policy) {
        return null;
    }
    return {
        ...entry,
        label: entry.label || policy.label,
        description: entry.description || policy.description,
    };
}

function useEntries(): IndexEntry[] {
    const role = usePerson()?.role;
    const admin = allows(role, "admin");
    const policies = usePolicies(admin);
    return useMemo(() => {
        const shown = new Set(SETTINGS_PAGES.filter(visibleTo(role)).map((page) => page.path));
        const byName = new Map((policies.data ?? []).map((policy) => [policy.name, policy]));
        return SETTINGS_INDEX.filter(
            (entry) => shown.has(entry.path) && (!entry.role || allows(role, entry.role)),
        )
            .map((entry) => withServerText(entry, byName))
            .filter((entry): entry is IndexEntry => entry !== null);
    }, [role, policies.data]);
}

function startsWord(text: string, term: string): boolean {
    return text.startsWith(term) || text.includes(` ${term}`);
}

function score(entry: IndexEntry, terms: string[]): number | null {
    const label = foldText(entry.label);
    const aliases = foldText((entry.aliases ?? []).join(" | "));
    const section = foldText(entry.section);
    const other = foldText([entry.description, ...entry.keywords].join(" "));
    let total = 0;
    for (const term of terms) {
        if (label.includes(term)) {
            total += LABEL + (startsWord(label, term) ? LABEL_START : 0);
        } else if (aliases.includes(term)) {
            total += LABEL;
        } else if (section.includes(term)) {
            total += SECTION;
        } else if (other.includes(term)) {
            total += OTHER;
        } else {
            return null;
        }
    }
    return total;
}

function rank(entries: IndexEntry[], query: string): Hit[] {
    const terms = searchTerms(query);
    if (terms.length === 0) {
        return [];
    }
    return entries
        .map((entry, order) => ({ entry, order, score: score(entry, terms) }))
        .filter((hit): hit is Hit => hit.score !== null)
        .sort((left, right) => right.score - left.score || left.order - right.order);
}

function pageLabel(path: string): string {
    return SETTINGS_PAGES.find((page) => page.path === path)?.label ?? path;
}

function grouped(hits: Hit[]): SearchMenuGroup<IndexEntry>[] {
    const groups = new Map<string, IndexEntry[]>();
    for (const hit of hits) {
        groups.set(hit.entry.path, [...(groups.get(hit.entry.path) ?? []), hit.entry]);
    }
    return [...groups].map(([path, items]) => ({ key: path, label: pageLabel(path), items }));
}

function hrefOf(entry: IndexEntry): string {
    return entry.anchor ? `${entry.path}#${entry.anchor}` : entry.path;
}

function emptyText(query: string, entries: IndexEntry[]): string {
    const terms = searchTerms(query);
    const broader = terms.find((term) => rank(entries, term).length > 0);
    const tried = `Nothing matches “${query.trim()}”.`;
    return broader && terms.length > 1
        ? `${tried} Try fewer words, such as “${broader}”.`
        : `${tried} Try a broader word, such as ${SUGGESTIONS}.`;
}

function typing(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    );
}

function useFocusKeys(focus: () => void) {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const mod = event.metaKey || event.ctrlKey;
            const slash = event.key === "/" && !mod && !event.altKey && !typing(event.target);
            const commandK = mod && !event.altKey && event.key.toLowerCase() === "k";
            if (slash || commandK) {
                event.preventDefault();
                focus();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [focus]);
}

function Result({ entry, query }: { entry: IndexEntry; query: string }) {
    return (
        <>
            <HighlightText text={entry.label} query={query} className="font-medium" />
            <span className="line-clamp-2 text-muted-foreground">
                {entry.section && (
                    <>
                        <HighlightText text={entry.section} query={query} />
                        {" · "}
                    </>
                )}
                <HighlightText text={entry.description} query={query} />
            </span>
        </>
    );
}

export function SettingsSearch() {
    const router = useRouter();
    const rail = useRail();
    const entries = useEntries();
    const input = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [focusPending, setFocusPending] = useState(false);
    const groups = useMemo(() => grouped(rank(entries, query)), [entries, query]);
    const focus = useMemo(
        () => () => {
            if (rail.collapsed) {
                rail.setCollapsed(false);
                setFocusPending(true);
            } else {
                input.current?.focus();
            }
        },
        [rail],
    );
    useFocusKeys(focus);
    useEffect(() => {
        if (focusPending && !rail.collapsed) {
            input.current?.focus();
            setFocusPending(false);
        }
    }, [focusPending, rail.collapsed]);
    if (rail.collapsed) {
        return (
            <NavItem
                icon={Search}
                label="Search settings"
                title="Search settings"
                onClick={focus}
                iconStyle="plain"
            />
        );
    }
    return (
        <SearchMenu
            groups={groups}
            query={query}
            onQueryChange={setQuery}
            itemKey={(entry) => entry.key}
            itemText={(entry) => entry.label}
            renderItem={(entry) => <Result entry={entry} query={query} />}
            onPick={(entry) => router.history.push(hrefOf(entry))}
            label="Search settings"
            placeholder="Search settings"
            shortcut="/"
            empty={groups.length === 0 ? emptyText(query, entries) : undefined}
            inputRef={input}
            className="mb-2"
        />
    );
}
