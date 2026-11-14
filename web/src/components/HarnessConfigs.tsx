import {
    CodeBlock,
    type CodeLanguage,
    Link,
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    type SoftwareId,
    SoftwareLogo,
} from "obp-ui";
import { useState } from "react";
import { API_REFERENCE_PATH } from "~/lib/modelLinks";

type HarnessGroup = "language" | "tool";

export type Harness = {
    id: string;
    label: string;
    logo: SoftwareId;
    group: HarnessGroup;
    language: CodeLanguage;
    file: string;
    code: string;
};

const GROUPS: { id: HarnessGroup; label: string }[] = [
    { id: "language", label: "Languages" },
    { id: "tool", label: "Frameworks and apps" },
];

export const SAMPLE = "I was charged twice";

export function harnesses(baseUrl: string, model: string, key: string): Harness[] {
    return [
        {
            id: "curl",
            label: "curl",
            logo: "curl",
            group: "language",
            language: "bash",
            file: "Terminal",
            code: [
                `curl ${baseUrl}/chat/completions \\`,
                `  -H "Authorization: Bearer ${key}" \\`,
                `  -H "Content-Type: application/json" \\`,
                "  -d '{",
                `    "model": "${model}",`,
                `    "messages": [{"role": "user", "content": "${SAMPLE}"}]`,
                "  }'",
            ].join("\n"),
        },
        {
            id: "python",
            label: "Python",
            logo: "python",
            group: "language",
            language: "python",
            file: "app.py · pip install openai",
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
            logo: "javascript",
            group: "language",
            language: "javascript",
            file: "app.mjs · npm install openai",
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
            logo: "dotenv",
            group: "language",
            language: "bash",
            file: ".env",
            code: [
                `OPENAI_BASE_URL=${baseUrl}`,
                `OPENAI_API_KEY=${key}`,
                `OPENAI_MODEL=${model}`,
            ].join("\n"),
        },
        {
            id: "langchain",
            label: "LangChain",
            logo: "langchain",
            group: "tool",
            language: "python",
            file: "app.py · pip install langchain-openai",
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
            logo: "llamaindex",
            group: "tool",
            language: "python",
            file: "app.py · pip install llama-index-llms-openai-like",
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
            logo: "litellm",
            group: "tool",
            language: "yaml",
            file: "config.yaml",
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
            logo: "continue",
            group: "tool",
            language: "yaml",
            file: "~/.continue/config.yaml",
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
            logo: "openwebui",
            group: "tool",
            language: "text",
            file: "Admin settings › Connections › OpenAI API",
            code: [`URL: ${baseUrl}`, `Key: ${key}`, `Model: ${model}`].join("\n"),
        },
    ];
}

function HarnessSelect({
    items,
    value,
    onChange,
}: {
    items: Harness[];
    value: Harness;
    onChange: (id: string) => void;
}) {
    return (
        <Select value={value.id} onValueChange={(next) => next && onChange(String(next))}>
            <SelectTrigger aria-label="Language or tool" className="h-7 w-40 shrink-0">
                <span className="flex min-w-0 items-center gap-2 text-foreground">
                    <SoftwareLogo id={value.logo} className="size-4 shrink-0" />
                    <span className="truncate">{value.label}</span>
                </span>
            </SelectTrigger>
            <SelectContent>
                {GROUPS.map((group) => (
                    <SelectGroup key={group.id}>
                        <SelectLabel>{group.label}</SelectLabel>
                        {items
                            .filter((entry) => entry.group === group.id)
                            .map((entry) => (
                                <SelectItem
                                    key={entry.id}
                                    value={entry.id}
                                    icon={<SoftwareLogo id={entry.logo} className="size-4" />}
                                >
                                    {entry.label}
                                </SelectItem>
                            ))}
                    </SelectGroup>
                ))}
            </SelectContent>
        </Select>
    );
}

export function HarnessConfigs({
    baseUrl,
    model,
    keyValue,
    hint = true,
}: {
    baseUrl: string;
    model: string;
    keyValue: string | null;
    hint?: boolean;
}) {
    const items = harnesses(baseUrl, model, keyValue ?? "YOUR_KEY");
    const [picked, setPicked] = useState(items[0]?.id ?? "curl");
    const item = items.find((entry) => entry.id === picked) ?? items[0];
    if (!item) {
        return null;
    }
    const title = (
        <span className="flex min-w-0 items-center gap-3">
            <HarnessSelect items={items} value={item} onChange={setPicked} />
            <span className="truncate font-mono">{item.file}</span>
        </span>
    );
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <CodeBlock
                code={item.code}
                language={item.language}
                title={title}
                copyLabel={`Copy the ${item.label} snippet`}
            />
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
