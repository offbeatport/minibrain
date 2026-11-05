import type {
    ContractInfo,
    JudgeInfo,
    PromotionInfo,
    RuleCheck,
    ThresholdInfo,
} from "~/api/client";
import { metricName } from "~/lib/metrics";

const GRADER_PHRASES: Record<string, string> = {
    judge: "a judge model's score against a rubric",
    text_similarity: "word overlap with the expected answer",
    exact_match: "exact match with the expected answer",
    label_accuracy: "the share of right labels",
    json_valid: "valid JSON that fits the schema",
    json_field_match: "the share of expected fields it gets right",
};

const OPERATOR_WORDS: Record<ThresholdInfo["op"], string> = {
    ">=": "at least",
    "<=": "at most",
    "==": "exactly",
    ">": "above",
    "<": "below",
};

const SHOWN_LABELS = 6;

function sentence(text: string): string {
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function joined(parts: string[]): string {
    if (parts.length < 2) {
        return parts.join("");
    }
    return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function wholePercent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

export function graderPhrase(name: string): string {
    return GRADER_PHRASES[name] ?? metricName(name).toLowerCase();
}

export function gradersSentence(names: string[]): string {
    const [main, ...others] = names;
    if (!main) {
        return "No graders yet.";
    }
    const also = others.length > 0 ? `; also ${joined(others.map(graderPhrase))}` : "";
    return sentence(`${graderPhrase(main)}${also}`);
}

export function thresholdPhrase(threshold: ThresholdInfo): string {
    return `${metricName(threshold.metric).toLowerCase()} is ${OPERATOR_WORDS[threshold.op]} ${wholePercent(threshold.value)}`;
}

export function ruleSentence(rule: PromotionInfo, main: string | null | undefined): string {
    const parts = (rule.thresholds ?? []).map(thresholdPhrase);
    if (rule.beats_live ?? true) {
        parts.push(`it beats the live version on ${metricName(main).toLowerCase()} (a tie counts)`);
    }
    return parts.length === 0 ? "Any ready version can go live." : sentence(joined(parts));
}

export function contractSentence(
    contract: ContractInfo,
    number: number,
    conversation: boolean,
): string {
    if (contract.labels) {
        const shown = contract.labels.slice(0, SHOWN_LABELS).join(", ");
        const more = contract.labels.length > SHOWN_LABELS ? ", …" : "";
        return `One label of ${contract.labels.length}: ${shown}${more}. Contract ${number}.`;
    }
    if (contract.kind === "json") {
        const fields = Object.keys(
            (contract.json_schema?.properties as Record<string, unknown> | undefined) ?? {},
        );
        return `JSON that fits a schema${fields.length > 0 ? ` with ${joined(fields)}` : ""}. Contract ${number}.`;
    }
    return conversation ? "Free text, over a conversation." : "Free text.";
}

export function judgeSentence(judge: JudgeInfo): string {
    if (!judge.used) {
        return judge.source === "base"
            ? "No judge model is chosen, so answers get no judge score."
            : `${judge.name} is the judge model, but the graders leave the judge out.`;
    }
    if (judge.source === "model") {
        return `${judge.name}, chosen for this model.`;
    }
    return judge.source === "install"
        ? `${judge.name}, this install's judge model.`
        : `${judge.name}, its own base, because no judge model is chosen.`;
}

function scored(value: number | null | undefined): string {
    return value === null || value === undefined ? "no score" : wholePercent(value);
}

export function checkSentence(check: RuleCheck): string {
    const metric = metricName(check.metric).toLowerCase();
    if (!check.metric) {
        return sentence(check.detail);
    }
    if (check.live === null || check.live === undefined) {
        const wanted = `${metric} ${OPERATOR_WORDS[check.op ?? ">="]} ${scored(check.target)}`;
        const found =
            check.actual === null || check.actual === undefined
                ? check.detail
                : `it is ${scored(check.actual)}`;
        return sentence(`${wanted}: ${found}`);
    }
    if (check.target === null || check.target === undefined) {
        return `Beats the live v${check.live}: it has no ${metric} to compare with.`;
    }
    return `Beats the live v${check.live} on ${metric}: ${scored(check.actual)} against ${scored(check.target)}.`;
}
