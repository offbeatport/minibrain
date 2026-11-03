import type { SqlDiagnostic } from "obp-ui";
import { errorText } from "./format";

const CONTEXT = /\n+LINE (\d+): (.*)\n( *)(\^+)\s*$/;
const ELLIPSIS = "...";

export type SqlProblem = { message: string; diagnostics: SqlDiagnostic[] };

type Excerpt = { head: string; tail: string; token: number };

function matchedAt(sql: string, at: number, { head, tail, token }: Excerpt): number {
    let forward = 0;
    while (forward < tail.length && sql[at + forward] === tail[forward]) {
        forward++;
    }
    if (forward < Math.min(token, tail.length)) {
        return 0;
    }
    let backward = 0;
    while (backward < head.length && sql[at - 1 - backward] === head[head.length - 1 - backward]) {
        backward++;
    }
    return forward + backward;
}

function locate(sql: string, excerpt: Excerpt): number | null {
    let best: number | null = null;
    let bestScore = 0;
    let tied = false;
    for (let at = 0; at <= sql.length; at++) {
        const score = matchedAt(sql, at, excerpt);
        if (score > bestScore) {
            best = at;
            bestScore = score;
            tied = false;
        } else if (score > 0 && score === bestScore) {
            tied = true;
        }
    }
    return tied ? null : best;
}

function position(sql: string, offset: number) {
    const before = sql.slice(0, offset).split("\n");
    return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}

export function sqlProblem(
    error: unknown,
    sent: string | undefined,
    current: string,
): SqlProblem | null {
    if (!error) {
        return null;
    }
    const text = errorText(error);
    const found = CONTEXT.exec(text);
    if (!found || sent === undefined) {
        return { message: text, diagnostics: [] };
    }
    const [, line = "", excerpt = "", indent = "", carets = ""] = found;
    const cut = excerpt.startsWith(ELLIPSIS) ? ELLIPSIS.length : 0;
    const fragment = excerpt.slice(cut, excerpt.endsWith(ELLIPSIS) ? -ELLIPSIS.length : undefined);
    const caret = indent.length - `LINE ${line}: `.length - cut;
    const at = locate(sent, {
        head: fragment.slice(0, caret),
        tail: fragment.slice(caret),
        token: carets.length,
    });
    if (at === null) {
        return { message: text, diagnostics: [] };
    }
    const message = text.slice(0, found.index).trim();
    if (sent !== current) {
        return { message, diagnostics: [] };
    }
    return {
        message,
        diagnostics: [
            {
                ...position(sent, at),
                length: carets.length > 1 ? carets.length : undefined,
                message,
            },
        ],
    };
}
