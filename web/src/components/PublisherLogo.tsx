import ai2 from "~/assets/publishers/ai2.svg";
import deepseek from "~/assets/publishers/deepseek.svg";
import google from "~/assets/publishers/google.svg";
import huggingface from "~/assets/publishers/huggingface.svg";
import ibm from "~/assets/publishers/ibm.svg";
import meta from "~/assets/publishers/meta.svg";
import microsoft from "~/assets/publishers/microsoft.svg";
import mistral from "~/assets/publishers/mistral.svg";
import nvidia from "~/assets/publishers/nvidia.svg";
import openai from "~/assets/publishers/openai.svg";
import qwen from "~/assets/publishers/qwen.svg";

type Logo = { src: string; mono?: boolean };

const LOGOS: Record<string, Logo> = {
    Qwen: { src: qwen },
    Google: { src: google },
    Meta: { src: meta },
    "Mistral AI": { src: mistral },
    Microsoft: { src: microsoft },
    IBM: { src: ibm, mono: true },
    NVIDIA: { src: nvidia },
    DeepSeek: { src: deepseek },
    OpenAI: { src: openai, mono: true },
    "Allen AI": { src: ai2 },
    "Hugging Face": { src: huggingface },
};

function monoMask(src: string) {
    const image = `url("${src}")`;
    return {
        maskImage: image,
        WebkitMaskImage: image,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
    };
}

export function PublisherLogo({ publisher, name }: { publisher?: string | null; name: string }) {
    const logo = publisher ? LOGOS[publisher] : undefined;
    return (
        <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background"
        >
            {logo?.mono && <span className="size-5 bg-foreground" style={monoMask(logo.src)} />}
            {logo && !logo.mono && <img src={logo.src} alt="" className="size-5" />}
            {!logo && (
                <span className="text-sm font-semibold text-muted-foreground">
                    {name.trim().charAt(0).toUpperCase()}
                </span>
            )}
        </span>
    );
}
