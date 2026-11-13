import { useRouter } from "@tanstack/react-router";
import { Gauge, Settings2, TriangleAlert } from "lucide-react";
import {
    Button,
    Checkbox,
    Input,
    NumberField,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SettingsGroup,
    SettingsRow,
    Textarea,
    useToast,
} from "obp-ui";
import { useState } from "react";
import { CopyButton } from "~/components/CopyButton";
import { PanelSection, PanelSections } from "~/components/Section";
import { PickerDialog } from "~/components/avatar/AvatarPicker";
import { choiceFor } from "~/components/avatar/avatarSvg";
import {
    type FlowModel,
    GRADER_CHOICES,
    JUDGES,
    deleteModels,
    editModel,
    flowHref,
    gradersOf,
    jobHref,
    judgeOf,
    startRescore,
    useFlowState,
} from "./modelsFlowData";
import { type Confirm, ConfirmDialog } from "./modelsFlowDialogs";
import { ModelAvatar } from "./modelsFlowParts";

const NO_JUDGE = "none";

function same(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((item) => b.includes(item));
}

function splitTags(text: string): string[] {
    return text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function General({ model }: { model: FlowModel }) {
    const toast = useToast();
    const [name, setName] = useState(model.name);
    const [description, setDescription] = useState(model.description);
    const [tags, setTags] = useState(model.tags.join(", "));
    const [picking, setPicking] = useState(false);
    const nextTags = splitTags(tags);
    const dirty =
        name.trim() !== model.name ||
        description.trim() !== model.description ||
        !same(nextTags, model.tags);
    const save = () => {
        editModel(model.slug, {
            name: name.trim() || model.name,
            description: description.trim(),
            tags: nextTags,
        });
        toast({ title: "Saved", tone: "success" });
    };
    return (
        <PanelSection
            icon={Settings2}
            title="General"
            actions={
                <Button disabled={!dirty} onClick={save}>
                    Save
                </Button>
            }
        >
            <SettingsGroup>
                <SettingsRow
                    id="settings-name"
                    label="Name"
                    control={
                        <Input
                            id="settings-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            className="w-72 max-w-full"
                        />
                    }
                />
                <SettingsRow
                    label="API name"
                    control={
                        <span className="flex items-center gap-1">
                            <span className="font-mono">{model.slug}</span>
                            <CopyButton value={model.slug} label="Copy API name" />
                        </span>
                    }
                />
                <SettingsRow
                    label="Avatar"
                    control={
                        <span className="flex items-center gap-3">
                            <ModelAvatar model={model} />
                            <Button variant="outline" onClick={() => setPicking(true)}>
                                Change
                            </Button>
                        </span>
                    }
                />
                <SettingsRow
                    id="settings-description"
                    label="Description"
                    wide
                    control={
                        <Textarea
                            id="settings-description"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            rows={2}
                        />
                    }
                />
                <SettingsRow
                    id="settings-tags"
                    label="Tags"
                    control={
                        <Input
                            id="settings-tags"
                            value={tags}
                            placeholder="support, routing"
                            onChange={(event) => setTags(event.target.value)}
                            className="w-72 max-w-full"
                        />
                    }
                />
            </SettingsGroup>
            <PickerDialog
                open={picking}
                onOpenChange={setPicking}
                name={model.name}
                value={model.avatar ?? choiceFor("initials", model.name)}
                onUse={(avatar) => editModel(model.slug, { avatar })}
            />
        </PanelSection>
    );
}

function GraderChecks({
    choices,
    value,
    onChange,
}: {
    choices: string[];
    value: string[];
    onChange: (next: string[]) => void;
}) {
    return (
        <span className="flex flex-col gap-2">
            {choices.map((grader) => (
                <label key={grader} className="flex items-center gap-2">
                    <Checkbox
                        checked={value.includes(grader)}
                        onCheckedChange={(on) =>
                            onChange(
                                on === true
                                    ? [...value, grader]
                                    : value.filter((item) => item !== grader),
                            )
                        }
                    />
                    {grader}
                </label>
            ))}
        </span>
    );
}

function Evaluation({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const router = useRouter();
    const toast = useToast();
    const choices = GRADER_CHOICES[model.task] ?? [...model.metrics];
    const [graders, setGraders] = useState(gradersOf(model));
    const [judge, setJudge] = useState(judgeOf(model) ?? NO_JUDGE);
    const [floor, setFloor] = useState(Math.round(model.rule[0] * 100));
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const rescores = !same(graders, gradersOf(model)) || judge !== (judgeOf(model) ?? NO_JUDGE);
    const ruleChanged = floor !== Math.round(model.rule[0] * 100);
    const scored = model.versions.filter((version) => version.status !== "failed").length;
    const apply = () => {
        editModel(model.slug, {
            graders,
            judge: judge === NO_JUDGE ? null : judge,
            rule: [floor / 100, model.rule[1]],
        });
        if (!rescores) {
            toast({ title: "Promotion rule saved", tone: "success" });
            return;
        }
        const id = startRescore(state.mode, model.slug);
        toast({
            title: `Re-scoring ${scored} versions`,
            description: `Job #${id}`,
            action: { label: "View job", onClick: () => router.history.push(jobHref(id)) },
        });
    };
    const save = () => {
        if (!rescores) {
            apply();
            return;
        }
        setConfirm({
            title: `Re-score ${scored} versions?`,
            description: <p>Every version is scored again on the held-out rows.</p>,
            label: "Save and re-score",
            primary: true,
            run: apply,
        });
    };
    return (
        <PanelSection
            icon={Gauge}
            title="Evaluation"
            actions={
                <Button
                    disabled={(!rescores && !ruleChanged) || graders.length === 0}
                    onClick={save}
                >
                    {rescores ? "Save and re-score" : "Save"}
                </Button>
            }
        >
            <SettingsGroup>
                <SettingsRow
                    label="Graders"
                    control={
                        <GraderChecks choices={choices} value={graders} onChange={setGraders} />
                    }
                />
                <SettingsRow
                    id="settings-judge"
                    label="Judge"
                    control={
                        <Select value={judge} onValueChange={(next) => setJudge(String(next))}>
                            <SelectTrigger id="settings-judge" className="w-56">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={NO_JUDGE} label="None">
                                    None
                                </SelectItem>
                                {JUDGES.map((item) => (
                                    <SelectItem key={item} value={item} label={item}>
                                        {item}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    }
                />
                <SettingsRow
                    id="settings-rule"
                    label="Promotion rule"
                    description={`${graders[0] ?? model.metrics[0]} at least, and beats deployed`}
                    control={
                        <NumberField
                            id="settings-rule"
                            value={floor}
                            onValueChange={(value) => setFloor(value ?? floor)}
                            min={0}
                            max={100}
                            step={1}
                            unit="%"
                            format={{ maximumFractionDigits: 0 }}
                        />
                    }
                />
            </SettingsGroup>
            <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
        </PanelSection>
    );
}

function Danger({ model }: { model: FlowModel }) {
    const router = useRouter();
    const toast = useToast();
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const custom = model.kind === "custom";
    const later = (what: string) => () =>
        toast({ title: "Not in the prototype", description: what });
    const remove = () =>
        setConfirm({
            title: `Delete ${model.name}?`,
            description: (
                <p>
                    {custom
                        ? `${model.name} goes with every version, key and score.`
                        : `${model.name} goes with every variant file and key.`}
                </p>
            ),
            label: "Delete model",
            run: () => {
                deleteModels([model.slug]);
                toast({ title: `Deleted ${model.name}`, tone: "success" });
                router.history.push(flowHref());
            },
        });
    return (
        <PanelSection icon={TriangleAlert} title="Danger zone">
            <SettingsGroup>
                {custom && (
                    <SettingsRow
                        label="Switch base"
                        description={model.base}
                        control={
                            <Button
                                variant="outline"
                                onClick={later(`Would train ${model.name} on another base.`)}
                            >
                                Switch base
                            </Button>
                        }
                    />
                )}
                {custom && (
                    <SettingsRow
                        label="Duplicate"
                        control={
                            <Button
                                variant="outline"
                                onClick={later(
                                    `Would copy ${model.name} with its settings; pick another dataset for the copy.`,
                                )}
                            >
                                Duplicate
                            </Button>
                        }
                    />
                )}
                <SettingsRow
                    label="Delete"
                    control={
                        <Button variant="destructive" onClick={remove}>
                            Delete model
                        </Button>
                    }
                />
            </SettingsGroup>
            <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
        </PanelSection>
    );
}

export function SettingsTab({ model }: { model: FlowModel }) {
    const custom = model.kind === "custom";
    return (
        <PanelSections>
            {custom && <General model={model} />}
            {custom && <Evaluation model={model} />}
            <Danger model={model} />
        </PanelSections>
    );
}
