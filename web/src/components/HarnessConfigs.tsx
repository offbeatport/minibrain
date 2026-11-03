import { Check, Copy } from "lucide-react";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "obp-ui";
import { useState } from "react";

type Harness = { id: string; label: string; file?: string; code: string };

const SAMPLE = "I was charged twice";

export function harnesses(baseUrl: string, model: string, key: string): Harness[] {
    return [
        {
            id: "curl",
            label: "curl",
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
            file: "config.yaml",
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
            file: "Settings → Connections → OpenAI API",
            code: [`URL: ${baseUrl}`, `Key: ${key}`, `Model: ${model}`].join("\n"),
        },
    ];
}

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () =>
        navigator.clipboard?.writeText(text).then(
            () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
            },
            () => setCopied(false),
        );
    return (
        <Button type="button" variant="outline" size="sm" onClick={copy}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
        </Button>
    );
}

export function HarnessConfigs({
    baseUrl,
    model,
    keyValue,
}: {
    baseUrl: string;
    model: string;
    keyValue: string | null;
}) {
    const key = keyValue ?? "YOUR_KEY";
    const items = harnesses(baseUrl, model, key);
    return (
        <Tabs defaultValue="curl">
            <div className="overflow-x-auto">
                <TabsList variant="line">
                    {items.map((item) => (
                        <TabsTrigger key={item.id} value={item.id}>
                            {item.label}
                        </TabsTrigger>
                    ))}
                </TabsList>
            </div>
            {items.map((item) => (
                <TabsContent key={item.id} value={item.id} className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-muted-foreground">
                            {item.file ?? "Copy, paste and run."}
                        </span>
                        <CopyButton text={item.code} />
                    </div>
                    <pre className="overflow-x-auto rounded-md border bg-secondary p-3 font-mono text-sm">
                        {item.code}
                    </pre>
                </TabsContent>
            ))}
            {!keyValue && (
                <p className="text-sm text-muted-foreground">
                    Replace YOUR_KEY with a key from the list below; a new key is filled in here
                    once.
                </p>
            )}
        </Tabs>
    );
}
