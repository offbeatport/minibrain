import {
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Field,
    FieldGroup,
    Input,
} from "obp-ui";
import { type FormEvent, type ReactNode, useState } from "react";
import {
    type SessionInfo,
    useSetPassword,
    useSetup,
    useSignIn,
    useSignOut,
} from "~/api/authQueries";
import { ErrorLine } from "~/components/Section";

const MIN_PASSWORD = 12;

const SETUP_REASONS: Record<string, string> = {
    listen: "minibrain listens on a network address, so everyone who opens it signs in.",
    remote: "This page came through a proxy or from another machine, so everyone who opens it signs in.",
};

function AuthFrame({
    title,
    description,
    children,
    footer,
}: {
    title: string;
    description?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
}) {
    return (
        <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-[12vh] pb-8">
            <div className="flex w-full max-w-sm flex-col gap-4">
                <span className="text-base font-semibold">minibrain</span>
                <Card>
                    <CardHeader>
                        <CardTitle>
                            <h1 className="text-xl font-semibold">{title}</h1>
                        </CardTitle>
                        {description && <CardDescription>{description}</CardDescription>}
                    </CardHeader>
                    <CardContent>{children}</CardContent>
                </Card>
                {footer && <div className="text-sm text-muted-foreground">{footer}</div>}
            </div>
        </main>
    );
}

function InsecureNotice() {
    if (typeof window === "undefined" || window.isSecureContext) {
        return null;
    }
    return (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm">
            This page is not served over HTTPS, so your browser will not keep you signed in. Put
            minibrain behind TLS, or open it on this machine at localhost.
        </p>
    );
}

function PasswordFields({
    password,
    again,
    onPassword,
    onAgain,
}: {
    password: string;
    again: string;
    onPassword: (value: string) => void;
    onAgain: (value: string) => void;
}) {
    const mismatch = again.length > 0 && again !== password;
    return (
        <>
            <Field id="password" label="Password" hint={`At least ${MIN_PASSWORD} characters.`}>
                <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => onPassword(event.target.value)}
                    minLength={MIN_PASSWORD}
                    required
                />
            </Field>
            <Field
                id="password-again"
                label="Password again"
                error={mismatch ? "The passwords do not match" : undefined}
            >
                <Input
                    id="password-again"
                    type="password"
                    autoComplete="new-password"
                    value={again}
                    onChange={(event) => onAgain(event.target.value)}
                    required
                />
            </Field>
        </>
    );
}

export function SignInPage() {
    const signIn = useSignIn();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const submit = (event: FormEvent) => {
        event.preventDefault();
        signIn.mutate({ email, password });
    };
    return (
        <AuthFrame
            title="Sign in"
            footer="Forgot your password? Ask an admin for a new password link."
        >
            <form onSubmit={submit}>
                <FieldGroup>
                    <InsecureNotice />
                    <Field id="email" label="Email">
                        <Input
                            id="email"
                            type="email"
                            autoComplete="username"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            required
                            autoFocus
                        />
                    </Field>
                    <Field id="password" label="Password">
                        <Input
                            id="password"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                        />
                    </Field>
                    <ErrorLine error={signIn.error} />
                    <Button type="submit" disabled={signIn.isPending}>
                        {signIn.isPending ? "Signing in…" : "Sign in"}
                    </Button>
                </FieldGroup>
            </form>
        </AuthFrame>
    );
}

export function AdminForm({ submitLabel }: { submitLabel: string }) {
    const setup = useSetup();
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [again, setAgain] = useState("");
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (password === again) {
            setup.mutate({ name, email, password });
        }
    };
    return (
        <form onSubmit={submit}>
            <FieldGroup>
                <Field id="admin-name" label="Name">
                    <Input
                        id="admin-name"
                        autoComplete="name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                </Field>
                <Field id="admin-email" label="Email">
                    <Input
                        id="admin-email"
                        type="email"
                        autoComplete="username"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        required
                    />
                </Field>
                <PasswordFields
                    password={password}
                    again={again}
                    onPassword={setPassword}
                    onAgain={setAgain}
                />
                <ErrorLine error={setup.error} />
                <Button
                    type="submit"
                    className="w-fit"
                    disabled={setup.isPending || password !== again}
                >
                    {setup.isPending ? "Creating…" : submitLabel}
                </Button>
            </FieldGroup>
        </form>
    );
}

export function SetupPage({ session }: { session: SessionInfo }) {
    return (
        <AuthFrame
            title="Create the admin account"
            description={`${SETUP_REASONS[session.reason ?? ""] ?? "Everyone who opens minibrain signs in."} You are the first person here, so you set up the admin.`}
            footer={
                <div className="flex flex-col gap-1">
                    <span>Or create it on the server:</span>
                    <code className="font-mono">
                        minibrain admin create --email you@example.com
                    </code>
                </div>
            }
        >
            <div className="flex flex-col gap-5">
                <InsecureNotice />
                <AdminForm submitLabel="Create admin account" />
            </div>
        </AuthFrame>
    );
}

function tokenFromHash(): string {
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    return new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? "";
}

export function SetPasswordPage({ onDone }: { onDone: () => void }) {
    const setPassword = useSetPassword();
    const [token] = useState(tokenFromHash);
    const [password, setPasswordValue] = useState("");
    const [again, setAgain] = useState("");
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (password === again) {
            setPassword.mutate({ token, password }, { onSuccess: onDone });
        }
    };
    if (!token) {
        return (
            <AuthFrame title="Choose a password">
                <p className="text-base">
                    This link is incomplete. Open the full link the admin sent you, or ask for a new
                    one.
                </p>
            </AuthFrame>
        );
    }
    return (
        <AuthFrame
            title="Choose a password"
            description="This link works once. After you save, you are signed in."
        >
            <form onSubmit={submit}>
                <FieldGroup>
                    <InsecureNotice />
                    <PasswordFields
                        password={password}
                        again={again}
                        onPassword={setPasswordValue}
                        onAgain={setAgain}
                    />
                    <ErrorLine error={setPassword.error} />
                    <Button type="submit" disabled={setPassword.isPending || password !== again}>
                        {setPassword.isPending ? "Saving…" : "Save password"}
                    </Button>
                </FieldGroup>
            </form>
        </AuthFrame>
    );
}

export function NoAccessPage({ session }: { session: SessionInfo }) {
    const signOut = useSignOut();
    const person = session.person;
    return (
        <AuthFrame
            title="Ask an admin for access"
            description={`You are signed in as ${person?.email ?? person?.name ?? "someone"}, but you do not have a role in minibrain yet.`}
        >
            <div className="flex flex-col gap-4">
                <p className="text-base">
                    An admin can give you one under Settings, Accounts. Then reload this page.
                </p>
                <Button
                    variant="outline"
                    className="w-fit"
                    onClick={() => signOut.mutate()}
                    disabled={signOut.isPending}
                >
                    Sign out
                </Button>
            </div>
        </AuthFrame>
    );
}
