import { Braces, Code, MessagesSquare, Waypoints } from "lucide-react";
import {
    CodeBlock,
    type CodeLanguage,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SoftwareLogo,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import { API_REFERENCE_PATH } from "~/lib/modelLinks";

export type Harness = {
    id: string;
    label: string;
    language: CodeLanguage;
    title?: string;
    code: string;
    icon?: ReactNode;
};

const ICONS: Record<string, ReactNode> = {
    curl: <SoftwareLogo id="curl" />,
    python: <SoftwareLogo id="python" />,
    javascript: <SoftwareLogo id="javascript" />,
    env: <SoftwareLogo id="dotenv" />,
    langchain: <SoftwareLogo id="langchain" />,
    llamaindex: <Braces />,
    litellm: <Waypoints />,
    continue: <Code />,
    openwebui: <MessagesSquare />,
};

function iconOf(item: Harness): ReactNode {
    return item.icon ?? ICONS[item.id] ?? <Code />;
}

export const SAMPLE = "I was charged twice";

export function harnesses(baseUrl: string, model: string, key: string): Harness[] {
    return [
        {
            id: "curl",
            label: "curl",
            language: "bash",
            code: [
                `curl ${baseUrl}/chat/completions \\`,
                `  -H "Authorization: Bearer ${key}" \\`,
                `  -H "Content-Type: application/json" \\`,
                `  -d '{"model": "${model}", "messages": [{"role": "user", "content": "${SAMPLE}"}]}'`,
            ].join("\n"),
        },
        {
            id: "python",
            label: "Python",
            language: "python",
            code: [
                "from openai import OpenAI",
                "",
                `client = OpenAI(base_url="${baseUrl}", api_key="${key}")`,
                "reply = client.chat.completions.create(",
                `    model="${model}",`,
                `    messages=[{"role": "user", "content": "${SAMPLE}"}],`,
                ")",
                "print(reply.choices[0].message.content)",
            ].join("\n"),
        },
        {
            id: "javascript",
            label: "JavaScript",
            language: "javascript",
            code: [
                'import OpenAI from "openai";',
                "",
                `const client = new OpenAI({ baseURL: "${baseUrl}", apiKey: "${key}" });`,
                "const reply = await client.chat.completions.create({",
                `    model: "${model}",`,
                `    messages: [{ role: "user", content: "${SAMPLE}" }],`,
                "});",
                "console.log(reply.choices[0].message.content);",
            ].join("\n"),
        },
        {
            id: "env",
            label: "Environment",
            language: "bash",
            title: ".env",
            code: [
                `OPENAI_BASE_URL=${baseUrl}`,
                `OPENAI_API_KEY=${key}`,
                `OPENAI_MODEL=${model}`,
            ].join("\n"),
        },
        {
            id: "langchain",
            label: "LangChain",
            language: "python",
            code: [
                "from langchain_openai import ChatOpenAI",
                "",
                `llm = ChatOpenAI(base_url="${baseUrl}", api_key="${key}", model="${model}")`,
                `print(llm.invoke("${SAMPLE}").content)`,
            ].join("\n"),
        },
        {
            id: "llamaindex",
            label: "LlamaIndex",
            language: "python",
            code: [
                "from llama_index.llms.openai_like import OpenAILike",
                "",
                "llm = OpenAILike(",
                `    api_base="${baseUrl}",`,
                `    api_key="${key}",`,
                `    model="${model}",`,
                "    is_chat_model=True,",
                ")",
                `print(llm.complete("${SAMPLE}"))`,
            ].join("\n"),
        },
        {
            id: "litellm",
            label: "LiteLLM",
            language: "yaml",
            title: "config.yaml",
            code: [
                "model_list:",
                `  - model_name: ${model}`,
                "    litellm_params:",
                `      model: openai/${model}`,
                `      api_base: ${baseUrl}`,
                `      api_key: ${key}`,
            ].join("\n"),
        },
        {
            id: "continue",
            label: "Continue",
            language: "yaml",
            title: "config.yaml",
            code: [
                "models:",
                `  - name: ${model}`,
                "    provider: openai",
                `    model: ${model}`,
                `    apiBase: ${baseUrl}`,
                `    apiKey: ${key}`,
            ].join("\n"),
        },
        {
            id: "openwebui",
            label: "Open WebUI",
            language: "text",
            title: "Settings → Connections → OpenAI API",
            code: [`URL: ${baseUrl}`, `Key: ${key}`, `Model: ${model}`].join("\n"),
        },
    ];
}

export function HarnessConfigs({
    baseUrl,
    model,
    keyValue,
    hint = true,
    extra = [],
}: {
    baseUrl: string;
    model: string;
    keyValue: string | null;
    hint?: boolean;
    extra?: Harness[];
}) {
    const key = keyValue ?? "YOUR_KEY";
    const all = harnesses(baseUrl, model, key);
    const items = [...all.slice(0, 3), ...extra, ...all.slice(3)];
    const [picked, setPicked] = useState(items[0]?.id ?? "curl");
    const item = items.find((entry) => entry.id === picked) ?? items[0];
    if (!item) {
        return null;
    }
    const title = (
        <span className="flex min-w-0 items-center gap-3">
            <Select value={item.id} onValueChange={(next) => next && setPicked(String(next))}>
                <SelectTrigger aria-label="Language or tool" className="h-7 w-44 shrink-0">
                    <span className="flex min-w-0 items-center gap-2 text-foreground [&_svg]:size-4 [&_svg]:shrink-0">
                        {iconOf(item)}
                        <span className="truncate">{item.label}</span>
                    </span>
                </SelectTrigger>
                <SelectContent>
                    {items.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id} icon={iconOf(entry)}>
                            {entry.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <span className="truncate">{item.title ?? "Copy, paste and run."}</span>
        </span>
    );
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <CodeBlock code={item.code} language={item.language} title={title} />
            {hint && (
                <p className="text-sm text-muted-foreground">
                    {!keyValue &&
                        "Replace YOUR_KEY with one of the API keys; a key you create is filled in here once. "}
                    Every endpoint, its fields and a client to try calls are in the{" "}
                    <Link href={API_REFERENCE_PATH} className="text-primary hover:underline">
                        API reference
                    </Link>
                    .
                </p>
            )}
        </div>
    );
}
