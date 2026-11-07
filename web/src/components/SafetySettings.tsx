import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import {
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SettingsGroup,
    SettingsRow,
    Switch,
} from "obp-ui";
import { type ModelDetail, api, unwrap } from "~/api/client";
import { keys, useSafetySetting } from "~/api/queries";
import type { components } from "~/api/schema";
import { PanelSection, errorMessage } from "~/components/Section";
import { useCan } from "~/lib/access";
import { GENERAL } from "~/pages/settings/settingsIndex";

type Guard = components["schemas"]["GuardInfo"];
type Mode = components["schemas"]["ModelSafetyUpdate"]["mode"];

const SAFETY = GENERAL.safety;
const NONE = "none";
const INHERIT = "inherit";
const DISCOVER = "/discover?task=Safety";

function GuardItems({ guards }: { guards: Guard[] }) {
    return guards.map((guard) => (
        <SelectItem key={guard.key} value={guard.key}>
            {guard.name}
        </SelectItem>
    ));
}

function NoGuards() {
    return (
        <p className="text-muted-foreground">
            No safety model is installed. Download Llama Guard, ShieldGemma, Qwen3Guard or
            gpt-oss-safeguard from{" "}
            <Link href={DISCOVER} className="text-primary hover:underline">
                Discover
            </Link>
            .
        </p>
    );
}

export function InstallSafety() {
    const client = useQueryClient();
    const setting = useSafetySetting();
    const save = useMutation({
        mutationFn: (body: { model: string | null; answers: boolean }) =>
            unwrap(api.PUT("/api/settings/safety", { body })),
        onSuccess: async (saved) => {
            client.setQueryData(keys.safety, saved);
            await client.invalidateQueries({ predicate: (query) => query.queryKey[0] === "model" });
        },
    });
    const guards = setting.data?.guards ?? [];
    const model = save.isPending ? (save.variables?.model ?? null) : (setting.data?.model ?? null);
    const answers = save.isPending
        ? Boolean(save.variables?.answers)
        : Boolean(setting.data?.answers);
    return (
        <PanelSection
            icon={ShieldCheck}
            anchor={SAFETY.anchor}
            title={SAFETY.title}
            description="A guard model on this install checks each request before the model answers it, and can check answers too. A blocked call gets a refusal with the categories found, and is logged and audited. Each model can pick its own on its Deployments page."
        >
            {guards.length === 0 && !model && <NoGuards />}
            <SettingsGroup>
                <SettingsRow
                    id="safety-model-select"
                    anchor={SAFETY.settings.safetyModel.anchor}
                    label={SAFETY.settings.safetyModel.label}
                    description={SAFETY.settings.safetyModel.description}
                    error={errorMessage(save.error ?? setting.error)}
                    control={
                        <Select
                            value={model ?? NONE}
                            onValueChange={(next) =>
                                save.mutate({
                                    model: !next || next === NONE ? null : String(next),
                                    answers,
                                })
                            }
                        >
                            <SelectTrigger id="safety-model-select" className="w-64">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={NONE}>None</SelectItem>
                                <GuardItems guards={guards} />
                            </SelectContent>
                        </Select>
                    }
                />
                <SettingsRow
                    id="safety-answers"
                    anchor={SAFETY.settings.safetyAnswers.anchor}
                    toggle={Boolean(model)}
                    disabled={!model}
                    label={SAFETY.settings.safetyAnswers.label}
                    description={SAFETY.settings.safetyAnswers.description}
                    control={
                        <Switch
                            id="safety-answers"
                            checked={answers}
                            disabled={!model}
                            readOnly={save.isPending}
                            onCheckedChange={(checked) => save.mutate({ model, answers: checked })}
                        />
                    }
                />
            </SettingsGroup>
        </PanelSection>
    );
}

export function ModelSafety({ detail }: { detail: ModelDetail }) {
    const client = useQueryClient();
    const can = useCan();
    const setting = useSafetySetting();
    const safety = detail.safety;
    const change = useMutation({
        mutationFn: (body: { mode: Mode; model: string | null; answers: boolean }) =>
            unwrap(
                api.PUT("/api/models/{slug}/safety", {
                    params: { path: { slug: detail.slug } },
                    body,
                }),
            ),
        onSuccess: async (next) => {
            client.setQueryData(keys.model(detail.slug), next);
            await client.invalidateQueries({ queryKey: ["audit"] });
        },
    });
    const guards = setting.data?.guards ?? [];
    const choice = safety.mode === "model" ? (safety.model ?? INHERIT) : safety.mode;
    const inherited = setting.data?.name ? `Settings: ${setting.data.name}` : "Settings: none";
    const pick = (next: string) => {
        if (next === INHERIT || next === NONE) {
            change.mutate({ mode: next, model: null, answers: false });
        } else {
            change.mutate({ mode: "model", model: next, answers: safety.answers });
        }
    };
    return (
        <PanelSection
            icon={ShieldCheck}
            title="Safety model"
            description={
                safety.effective
                    ? `${safety.effective_name ?? safety.effective} checks every request${safety.effective_answers ? " and answer" : ""} to this model; a blocked call gets a refusal and is audited.`
                    : "No safety model checks this model's calls."
            }
        >
            <SettingsGroup>
                <SettingsRow
                    id="model-safety-select"
                    disabled={!can.build}
                    label="Safety model"
                    description="Follow the install's choice under Settings, General, turn it off for this model, or pick another guard."
                    error={errorMessage(change.error)}
                    control={
                        <Select
                            value={choice}
                            disabled={!can.build}
                            onValueChange={(next) => pick(String(next ?? INHERIT))}
                        >
                            <SelectTrigger id="model-safety-select" className="w-64">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={INHERIT}>{inherited}</SelectItem>
                                <SelectItem value={NONE}>None for this model</SelectItem>
                                <GuardItems guards={guards} />
                            </SelectContent>
                        </Select>
                    }
                />
                {safety.mode === "model" && (
                    <SettingsRow
                        id="model-safety-answers"
                        toggle={can.build}
                        disabled={!can.build}
                        label="Also check answers"
                        description="Checks the model's answer too, before it is returned."
                        control={
                            <Switch
                                id="model-safety-answers"
                                checked={safety.answers}
                                disabled={!can.build}
                                readOnly={change.isPending}
                                onCheckedChange={(checked) =>
                                    change.mutate({
                                        mode: "model",
                                        model: safety.model,
                                        answers: checked,
                                    })
                                }
                            />
                        }
                    />
                )}
            </SettingsGroup>
        </PanelSection>
    );
}
