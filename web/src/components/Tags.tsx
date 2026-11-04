import { Badge } from "obp-ui";

export const SYSTEM_TAG_PREFIX = "minibrain:";

export function isSystemTag(tag: string): boolean {
    return tag.toLowerCase().startsWith(SYSTEM_TAG_PREFIX);
}

export function editableTags(tags: string[]): string {
    return tags.filter((tag) => !isSystemTag(tag)).join(", ");
}

export const TAGS_HINT = "Comma separated. Use key:value for structure, e.g. team:fraud.";

export const TAGS_HELP =
    "Comma separated. Tags show on the model and match in the Models search, so a shared key:value scheme pays off as the list grows: team:fraud finds every model the fraud team owns, env:prod everything live, data:pii whatever touches personal data. The API returns them too, for scripts that pick models by tag. Tags starting with minibrain: are set by minibrain.";

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
