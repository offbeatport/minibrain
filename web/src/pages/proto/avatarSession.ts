import {
    type AvatarChoice,
    TONE_LABELS,
    candidateChoices,
    lettersOf,
    randomTone,
    sameChoice,
} from "./avatarDicebear";
import { AVATAR_STYLES, type AvatarStyleId, styleById } from "./avatarStyles";
import { TONE_KEYS, type ToneName } from "./modelIcons";

export const GRID_SIZE = 12;
export const RECENT_LIMIT = 6;

let remembered: AvatarChoice[] = [];

type ByStyle<T> = Record<AvatarStyleId, T>;

export type Session = {
    tab: AvatarStyleId;
    pin: ToneName | null;
    letters: string;
    batches: ByStyle<AvatarChoice[]>;
    selected: ByStyle<AvatarChoice>;
    deal: number;
    recent: AvatarChoice[];
};

export function withRecent(list: AvatarChoice[], choice: AvatarChoice): AvatarChoice[] {
    return [choice, ...list.filter((item) => !sameChoice(item, choice))].slice(0, RECENT_LIMIT);
}

function byStyle<T>(make: (id: AvatarStyleId) => T): ByStyle<T> {
    return Object.fromEntries(
        AVATAR_STYLES.map((style) => [style.id, make(style.id)]),
    ) as ByStyle<T>;
}

function randomIndex(count: number): number {
    return crypto.getRandomValues(new Uint32Array(1))[0] % count;
}

export function startSession(value: AvatarChoice): Session {
    const letters = value.letters ?? "";
    const batches = byStyle((id) => {
        const batch = candidateChoices(id, GRID_SIZE, null, letters || undefined);
        if (!styleById(id).seeded) {
            return batch;
        }
        const [first, ...rest] = batch;
        return [id === value.style ? value : { ...first, tone: value.tone }, ...rest];
    });
    const selected = byStyle((id) =>
        id === value.style
            ? value
            : styleById(id).seeded
              ? batches[id][0]
              : { style: id, seed: "initials", tone: value.tone, letters: letters || undefined },
    );
    return {
        tab: value.style,
        pin: null,
        letters,
        batches,
        selected,
        deal: 0,
        recent: withRecent(remembered, value),
    };
}

export function draftOf(session: Session): AvatarChoice {
    return session.selected[session.tab];
}

export function recolour(session: Session, tone: ToneName): Session {
    return {
        ...session,
        pin: tone,
        batches: byStyle((id) =>
            styleById(id).seeded
                ? session.batches[id].map((choice) => ({ ...choice, tone }))
                : session.batches[id],
        ),
        selected: byStyle((id) => ({ ...session.selected[id], tone })),
    };
}

export function mixColours(session: Session): Session {
    return {
        ...session,
        pin: null,
        batches: byStyle((id) =>
            styleById(id).seeded
                ? session.batches[id].map((choice, index) =>
                      choice.seed === session.selected[id].seed
                          ? choice
                          : { ...choice, tone: TONE_KEYS[(index * 3) % TONE_KEYS.length] },
                  )
                : session.batches[id],
        ),
    };
}

export function withLetters(session: Session, letters: string): Session {
    const value = letters || undefined;
    return {
        ...session,
        letters,
        batches: {
            ...session.batches,
            initials: session.batches.initials.map((choice) => ({ ...choice, letters: value })),
        },
        selected: {
            ...session.selected,
            initials: { ...session.selected.initials, letters: value },
        },
    };
}

export function deal(session: Session): Session {
    const tab = session.tab;
    if (!styleById(tab).seeded) {
        return session;
    }
    return {
        ...session,
        recent: withRecent(session.recent, session.selected[tab]),
        batches: { ...session.batches, [tab]: candidateChoices(tab, GRID_SIZE, session.pin) },
        deal: session.deal + 1,
    };
}

export function choose(session: Session, choice: AvatarChoice): Session {
    if (!styleById(choice.style).seeded) {
        const letters = choice.letters ?? "";
        return recolour(withLetters({ ...session, tab: choice.style }, letters), choice.tone);
    }
    const batch = session.batches[choice.style];
    const shown = batch.some((item) => sameChoice(item, choice));
    return {
        ...session,
        tab: choice.style,
        batches: shown
            ? session.batches
            : { ...session.batches, [choice.style]: [choice, ...batch.slice(0, GRID_SIZE - 1)] },
        selected: { ...session.selected, [choice.style]: choice },
    };
}

export function surprise(session: Session): Session {
    const current = draftOf(session);
    const others = AVATAR_STYLES.filter((style) => style.id !== current.style);
    const style = others[randomIndex(others.length)].id;
    const tone = randomTone(current.tone);
    const recent = withRecent(session.recent, current);
    if (!styleById(style).seeded) {
        return {
            ...session,
            tab: style,
            recent,
            selected: { ...session.selected, [style]: { ...session.selected[style], tone } },
            deal: session.deal + 1,
        };
    }
    const [first, ...rest] = candidateChoices(style, GRID_SIZE, null);
    const picked = { ...first, tone };
    return {
        ...session,
        tab: style,
        pin: null,
        recent,
        batches: { ...session.batches, [style]: [picked, ...rest] },
        selected: { ...session.selected, [style]: picked },
        deal: session.deal + 1,
    };
}

export function finalChoice(choice: AvatarChoice): AvatarChoice {
    const { letters, ...rest } = choice;
    return styleById(choice.style).seeded || !letters ? rest : { ...rest, letters };
}

export function remember(choice: AvatarChoice): void {
    remembered = withRecent(remembered, choice);
}

export function describe(choice: AvatarChoice, name: string): string {
    const style = styleById(choice.style);
    const tone = TONE_LABELS[choice.tone];
    return style.seeded
        ? `${style.name} · ${tone}`
        : `${style.name} ${lettersOf(choice, name)} · ${tone}`;
}
