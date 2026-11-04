import { Badge } from "obp-ui";

export const SYSTEM_TAG_PREFIX = "minibrain:";

export function isSystemTag(tag: string): boolean {
    return tag.toLowerCase().startsWith(SYSTEM_TAG_PREFIX);
}

export function editableTags(tags: string[]): string {
    return tags.filter((tag) => !isSystemTag(tag)).join(", ");
}

export const TAGS_HINT = "Comma separated. Use key:value for structure, e.g. team:fraud.";

const TAG_EXAMPLES = [
    { tag: "team:fraud", finds: "the fraud team's models" },
    { tag: "env:prod", finds: "everything live" },
    { tag: "data:pii", finds: "anything with personal data" },
];

export function TagsHelp() {
    return (
        <div className="flex flex-col gap-2.5 p-1.5 text-left text-pretty">
            <p>Comma separated. Tags show on the model and match in Models search.</p>
            <div className="flex flex-col gap-1">
                <p className="font-medium">Use key:value to find groups</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                    {TAG_EXAMPLES.map((example) => (
                        <div key={example.tag} className="contents">
                            <dt className="font-mono">{example.tag}</dt>
                            <dd className="opacity-75">{example.finds}</dd>
                        </div>
                    ))}
                </dl>
            </div>
            <p className="opacity-75">
                The API returns tags too. Tags starting with minibrain: are set by minibrain.
            </p>
        </div>
    );
}

function TagBadge({ tag }: { tag: string }) {
    if (isSystemTag(tag)) {
        return <Badge variant="neutral">{tag.slice(SYSTEM_TAG_PREFIX.length)}</Badge>;
    }
    const [key, value] = tag.includes(":")
        ? [tag.split(":")[0], tag.split(":").slice(1).join(":")]
        : [null, tag];
    return (
        <Badge variant="outline">
            {key && <span className="text-muted-foreground">{`${key}:`}</span>}
            {value}
        </Badge>
    );
}

export function Tags({ tags }: { tags: string[] }) {
    if (tags.length === 0) {
        return null;
    }
    return (
        <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
                <li key={tag}>
                    <TagBadge tag={tag} />
                </li>
            ))}
        </ul>
    );
}
