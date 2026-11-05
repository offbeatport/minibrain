import { harnesses } from "~/components/HarnessConfigs";

type MediaType = { example?: unknown; [key: string]: unknown };
type CodeSample = { lang: string; label: string; source: string };
type SdkGuide = { lang: string; description: string };

export type Operation = {
    requestBody?: { content?: Record<string, MediaType> };
    "x-codeSamples"?: CodeSample[];
    [key: string]: unknown;
};

export type ApiDocument = {
    info: {
        title: string;
        version: string;
        description?: string;
        "x-scalar-sdk-installation"?: SdkGuide[];
        [key: string]: unknown;
    };
    servers?: { url: string; description?: string }[];
    paths: Record<string, Record<string, Operation>>;
    [key: string]: unknown;
};

export const KEY_PLACEHOLDER = "YOUR_KEY";
export const CSRF_PLACEHOLDER = "CSRF_TOKEN";
const EXAMPLE_MODEL = "support-triage";
const SAMPLE = "I was charged twice";
const CURL = "curl";
const PYTHON = "Python";
const JAVASCRIPT = "JavaScript";

function fenced(language: string, code: string): string {
    return `\`\`\`${language}\n${code}\n\`\`\``;
}

function curl(method: string, url: string, body?: unknown): string {
    const lines = [
        `curl${method === "GET" ? "" : ` -X ${method}`} ${url} \\`,
        `  -H "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
    ];
    if (body !== undefined) {
        lines[1] += " \\";
        lines.push(
            '  -H "Content-Type: application/json" \\',
            `  -d '${JSON.stringify(body, null, 2).replaceAll("\n", "\n  ")}'`,
        );
    }
    return lines.join("\n");
}

function pythonClient(baseUrl: string): string {
    return [
        "from openai import OpenAI",
        "",
        `client = OpenAI(base_url="${baseUrl}", api_key="${KEY_PLACEHOLDER}")`,
    ].join("\n");
}

function javascriptClient(baseUrl: string): string {
    return [
        'import OpenAI from "openai";',
        "",
        `const client = new OpenAI({ baseURL: "${baseUrl}", apiKey: "${KEY_PLACEHOLDER}" });`,
    ].join("\n");
}

function samples(curlCode: string, python: string, javascript: string): CodeSample[] {
    return [
        { lang: CURL, label: "curl", source: curlCode },
        { lang: PYTHON, label: "Python", source: python },
        { lang: JAVASCRIPT, label: "JavaScript", source: javascript },
    ];
}

function feedbackBody(model: string, responseId: string): Record<string, string> {
    return { model, response_id: responseId, rating: "down", correction: "billing", input: SAMPLE };
}

function gatewaySamples(baseUrl: string, model: string): Record<string, CodeSample[]> {
    const chat = Object.fromEntries(
        harnesses(baseUrl, model, KEY_PLACEHOLDER).map((item) => [item.id, item.code]),
    );
    const feedback = feedbackBody(model, "chatcmpl-abc123");
    const messages = `[{"role": "user", "content": "${SAMPLE}"}]`;
    return {
        "get /models": samples(
            curl("GET", `${baseUrl}/models`),
            [
                pythonClient(baseUrl),
                "",
                "for model in client.models.list():",
                "    print(model.id)",
            ].join("\n"),
            [
                javascriptClient(baseUrl),
                "",
                "for await (const model of client.models.list()) {",
                "    console.log(model.id);",
                "}",
            ].join("\n"),
        ),
        "post /chat/completions": samples(
            curl("POST", `${baseUrl}/chat/completions`, {
                model,
                messages: [{ role: "user", content: SAMPLE }],
            }),
            chat.python,
            chat.javascript,
        ),
        "post /feedback": samples(
            curl("POST", `${baseUrl}/feedback`, feedback),
            [
                pythonClient(baseUrl),
                "",
                `reply = client.chat.completions.create(model="${model}", messages=${messages})`,
                "client.post(",
                '    "/feedback",',
                "    cast_to=object,",
                `    body={"model": "${model}", "response_id": reply.id, "rating": "down", "correction": "billing", "input": "${SAMPLE}"},`,
                ")",
            ].join("\n"),
            [
                javascriptClient(baseUrl),
                "",
                "const reply = await client.chat.completions.create({",
                `    model: "${model}",`,
                `    messages: [{ role: "user", content: "${SAMPLE}" }],`,
                "});",
                'await client.post("/feedback", {',
                `    body: { model: "${model}", response_id: reply.id, rating: "down", correction: "billing", input: "${SAMPLE}" },`,
                "});",
            ].join("\n"),
        ),
    };
}

function gatewayExamples(model: string): Record<string, unknown> {
    return {
        "post /chat/completions": { model, messages: [{ role: "user", content: SAMPLE }] },
        "post /feedback": feedbackBody(model, "chatcmpl-abc123"),
    };
}

function withExample(operation: Operation, example: unknown): Operation {
    const json = operation.requestBody?.content?.["application/json"];
    if (example === undefined || !json) {
        return operation;
    }
    return {
        ...operation,
        requestBody: {
            ...operation.requestBody,
            content: {
                ...operation.requestBody?.content,
                "application/json": { ...json, example },
            },
        },
    };
}

function mapOperations(
    document: ApiDocument,
    change: (key: string, operation: Operation) => Operation,
): ApiDocument["paths"] {
    return Object.fromEntries(
        Object.entries(document.paths).map(([path, item]) => [
            path,
            Object.fromEntries(
                Object.entries(item).map(([method, operation]) => [
                    method,
                    change(`${method} ${path}`, operation),
                ]),
            ),
        ]),
    );
}

function inlineCode(name: string): string {
    return `\`${name.replaceAll("`", "")}\``;
}

function installNote(baseUrl: string, models: string[]): string {
    const names = models.length
        ? `Models deployed now: ${models.map(inlineCode).join(", ")}. A key calls the ones it covers.`
        : "No model is deployed yet. Deploy one from Deployments or a base model's page.";
    return `## On this install\n\nBase URL: ${inlineCode(baseUrl)}\n\n${names}`;
}

function gatewayGuides(baseUrl: string): SdkGuide[] {
    return [
        {
            lang: CURL,
            description: `Send the key as a bearer token.\n\n${fenced("bash", curl("GET", `${baseUrl}/models`))}`,
        },
        {
            lang: PYTHON,
            description: [
                "Install the OpenAI SDK, from your package mirror when offline, and point it at this install.",
                fenced("bash", "pip install openai"),
                fenced("python", pythonClient(baseUrl)),
            ].join("\n\n"),
        },
        {
            lang: JAVASCRIPT,
            description: [
                "Install the OpenAI SDK, from your package mirror when offline, and point it at this install.",
                fenced("bash", "npm install openai"),
                fenced("javascript", javascriptClient(baseUrl)),
            ].join("\n\n"),
        },
    ];
}

export function gatewayDocument(
    source: ApiDocument,
    origin: string,
    models: string[],
): ApiDocument {
    const baseUrl = `${origin}/v1`;
    const model = models[0] ?? EXAMPLE_MODEL;
    const codeSamples = gatewaySamples(baseUrl, model);
    const examples = gatewayExamples(model);
    return {
        ...source,
        info: {
            ...source.info,
            description: `${source.info.description ?? ""}\n\n${installNote(baseUrl, models)}`,
            "x-scalar-sdk-installation": gatewayGuides(baseUrl),
        },
        servers: [{ url: baseUrl, description: "This install" }],
        paths: mapOperations(source, (key, operation) => ({
            ...withExample(operation, examples[key]),
            "x-codeSamples": codeSamples[key],
        })),
    };
}

function managementGuides(origin: string): SdkGuide[] {
    const login = `${origin}/api/auth/login`;
    return [
        {
            lang: CURL,
            description: [
                "Keep the session cookie in a jar, and send the csrf_token from the sign-in answer on changes.",
                fenced(
                    "bash",
                    [
                        `curl -c session.txt ${login} \\`,
                        '  -H "Content-Type: application/json" \\',
                        `  -d '{"email": "you@example.com", "password": "..."}'`,
                        `curl -b session.txt ${origin}/api/models`,
                        `curl -b session.txt -X POST ${origin}/api/minibrains \\`,
                        `  -H "X-CSRF-Token: ${CSRF_PLACEHOLDER}" \\`,
                        '  -H "Content-Type: application/json" \\',
                        `  -d '{"name": "Ticket triage"}'`,
                    ].join("\n"),
                ),
            ].join("\n\n"),
        },
        {
            lang: PYTHON,
            description: [
                "A requests session keeps the cookie; add the CSRF token to its headers.",
                fenced(
                    "python",
                    [
                        "import requests",
                        "",
                        "session = requests.Session()",
                        `signed_in = session.post("${login}", json={"email": "you@example.com", "password": "..."})`,
                        'session.headers["X-CSRF-Token"] = signed_in.json()["csrf_token"]',
                        `print(session.get("${origin}/api/models").json())`,
                        `session.post("${origin}/api/minibrains", json={"name": "Ticket triage"})`,
                    ].join("\n"),
                ),
            ].join("\n\n"),
        },
        {
            lang: JAVASCRIPT,
            description: [
                "From a page on this install the browser sends the cookie; elsewhere keep it yourself.",
                fenced(
                    "javascript",
                    [
                        `const signedIn = await fetch("${login}", {`,
                        '    method: "POST",',
                        '    headers: { "Content-Type": "application/json" },',
                        '    body: JSON.stringify({ email: "you@example.com", password: "..." }),',
                        "});",
                        "const { csrf_token } = await signedIn.json();",
                        `const models = await fetch("${origin}/api/models").then((response) => response.json());`,
                        `await fetch("${origin}/api/minibrains", {`,
                        '    method: "POST",',
                        '    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf_token },',
                        '    body: JSON.stringify({ name: "Ticket triage" }),',
                        "});",
                    ].join("\n"),
                ),
            ].join("\n\n"),
        },
    ];
}

export function managementDocument(source: ApiDocument, origin: string, role: string): ApiDocument {
    const tryIt = `## Trying calls here\n\nSend uses your own session, signed in as ${role}, and adds the CSRF token. Calls run with your role and are audited like the same change in the UI.`;
    return {
        ...source,
        info: {
            ...source.info,
            description: `${source.info.description ?? ""}\n\n${tryIt}`,
            "x-scalar-sdk-installation": managementGuides(origin),
        },
        servers: [{ url: origin, description: "This install" }],
    };
}
