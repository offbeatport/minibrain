import { AVATAR_STYLES, type AvatarStyleId, styleById } from "./avatarStyles";
import {
    type AvatarChoice,
    ONE_LETTER,
    TWO_LETTERS,
    lettersOf,
    randomSeeds,
    randomTone,
    sameChoice,
} from "./avatarSvg";
import { TONE_LABELS, type ToneName } from "./tones";

export const GRID_SIZE = 12;
export const RECENT_LIMIT = 6;
export const CUSTOM_LETTERS = "custom";

const INITIALS_SHAPES = [TWO_LETTERS, ONE_LETTER];

let remembered: AvatarChoice[] = [];

type ByStyle<T> = Record<AvatarStyleId, T>;

export type Session = {
    style: AvatarStyleId;
    tone: ToneName;
    shapes: ByStyle<string>;
    options: ByStyle<string[]>;
    letters: string;
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

function freshOptions(style: AvatarStyleId): string[] {
    return styleById(style).seeded ? randomSeeds(GRID_SIZE) : INITIALS_SHAPES;
}

function shapeOf(choice: AvatarChoice): string {
    if (styleById(choice.style).seeded || choice.seed === ONE_LETTER) {
        return choice.seed;
    }
    return choice.letters ? CUSTOM_LETTERS : TWO_LETTERS;
}

function withShape(options: string[], shape: string): string[] {
    return options.includes(shape) ? options : [shape, ...options.slice(0, GRID_SIZE - 1)];
}

function choiceOf(
    style: AvatarStyleId,
    shape: string,
    tone: ToneName,
    letters: string,
): AvatarChoice {
    return shape === CUSTOM_LETTERS
        ? { style, seed: TWO_LETTERS, tone, letters }
        : { style, seed: shape, tone };
}

export function draftOf(session: Session): AvatarChoice {
    return choiceOf(session.style, session.shapes[session.style], session.tone, session.letters);
}

export function shapeChoices(session: Session): AvatarChoice[] {
    return session.options[session.style].map((seed) => ({
        style: session.style,
        seed,
        tone: session.tone,
    }));
}

export function startSession(value: AvatarChoice): Session {
    const seeded = styleById(value.style).seeded;
    const shape = shapeOf(value);
    const options = byStyle(freshOptions);
    if (seeded) {
        options[value.style] = withShape(options[value.style], shape);
    }
    const session: Session = {
        style: value.style,
        tone: value.tone,
        shapes: byStyle((id) => (id === value.style ? shape : options[id][0])),
        options,
        letters: seeded ? "" : (value.letters ?? ""),
        deal: 0,
        recent: [],
    };
    return { ...session, recent: withRecent(remembered, draftOf(session)) };
}

export function pickStyle(session: Session, style: AvatarStyleId): Session {
    return { ...session, style };
}

export function recolour(session: Session, tone: ToneName): Session {
    return { ...session, tone };
}

export function withLetters(session: Session, letters: string): Session {
    return {
        ...session,
        letters,
        shapes: { ...session.shapes, initials: letters ? CUSTOM_LETTERS : TWO_LETTERS },
    };
}

export function selectCustomLetters(session: Session): Session {
    return session.letters ? withLetters(session, session.letters) : session;
}

export function deal(session: Session): Session {
    if (!styleById(session.style).seeded) {
        return session;
    }
    return {
        ...session,
        recent: withRecent(session.recent, draftOf(session)),
        options: { ...session.options, [session.style]: randomSeeds(GRID_SIZE) },
        deal: session.deal + 1,
    };
}

export function choose(session: Session, choice: AvatarChoice): Session {
    const shape = shapeOf(choice);
    const seeded = styleById(choice.style).seeded;
    return {
        ...session,
        style: choice.style,
        tone: choice.tone,
        shapes: { ...session.shapes, [choice.style]: shape },
        options: seeded
            ? {
                  ...session.options,
                  [choice.style]: withShape(session.options[choice.style], shape),
              }
            : session.options,
        letters: shape === CUSTOM_LETTERS ? (choice.letters ?? "") : session.letters,
    };
}

export function surprise(session: Session): Session {
    const others = AVATAR_STYLES.filter((style) => style.id !== session.style);
    const style = others[randomIndex(others.length)].id;
    const options = freshOptions(style);
    return {
        ...session,
        style,
        tone: randomTone(session.tone),
        options: { ...session.options, [style]: options },
        shapes: { ...session.shapes, [style]: options[randomIndex(options.length)] },
        recent: withRecent(session.recent, draftOf(session)),
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
