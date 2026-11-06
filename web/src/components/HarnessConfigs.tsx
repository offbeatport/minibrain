import { type CodeLanguage, CodeTabs, Link } from "obp-ui";
import { API_REFERENCE_PATH } from "~/lib/modelLinks";

type Harness = { id: string; label: string; language: CodeLanguage; title?: string; code: string };

const SAMPLE = "I was charged twice";

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
}: {
    baseUrl: string;
    model: string;
    keyValue: string | null;
}) {
    const key = keyValue ?? "YOUR_KEY";
    const items = harnesses(baseUrl, model, key);
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <CodeTabs items={items} title="Copy, paste and run." />
            <p className="text-sm text-muted-foreground">
                {!keyValue &&
                    "Replace YOUR_KEY with a key from the list below; a new key is filled in here once. "}
                Every endpoint, its fields and a client to try calls are in the{" "}
                <Link href={API_REFERENCE_PATH} className="text-primary hover:underline">
                    API reference
                </Link>
                .
            </p>
        </div>
    );
}
