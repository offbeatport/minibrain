import {
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Field,
    FieldGroup,
    InfoTip,
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
import { signOutReason } from "~/api/client";
import { ErrorLine } from "~/components/Section";

const MIN_PASSWORD = 12;

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

function ssoHref(): string {
    const here =
        typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;
    const next = here.startsWith("/reset-password")
        ? "/"
        : here.replace(/[?&]sign_in_error=[^&]*/, "");
    return `/api/auth/oidc/start?next=${encodeURIComponent(next || "/")}`;
}

function ssoError(): string | null {
    const query = typeof window === "undefined" ? "" : window.location.search;
    return new URLSearchParams(query).get("sign_in_error");
}

function SingleSignOn({ label, divider }: { label: string; divider: string }) {
    const error = ssoError();
    return (
        <div className="flex flex-col gap-4">
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button asChild>
                <a href={ssoHref()}>{`Sign in with ${label}`}</a>
            </Button>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                {divider}
                <span className="h-px flex-1 bg-border" />
            </div>
        </div>
    );
}

export function SignInPage({ session }: { session?: SessionInfo }) {
    const signIn = useSignIn();
    const [reason] = useState(signOutReason);
    const sso = session?.methods.oidc;
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
                    {reason && (
                        <p className="rounded-md border bg-secondary px-3 py-2 text-sm">
                            {`${reason} Sign in again to carry on where you were.`}
                        </p>
                    )}
                    {sso && <SingleSignOn label={sso} divider="or with a password" />}
                    <Field id="email" label="Email">
                        <Input
                            id="email"
                            type="email"
                            autoComplete="username"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            required
                            autoFocus={!sso}
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
                    <Button
                        type="submit"
                        variant={sso ? "outline" : "default"}
                        disabled={signIn.isPending}
                    >
                        {signIn.isPending ? "Signing in…" : "Sign in"}
                    </Button>
                </FieldGroup>
            </form>
        </AuthFrame>
    );
}

const SETUP_TOKEN_INFO =
    "A one-time code minibrain prints in its log the first time it starts. It proves you run this server, so nobody else who can reach it creates the admin first. It works once; run minibrain admin setup-link on the server for a new one.";

function tokenFromQuery(): string {
    const query = typeof window === "undefined" ? "" : window.location.search;
    return new URLSearchParams(query).get("token")?.trim() ?? "";
}

function AdminForm({ linkToken }: { linkToken: string }) {
    const setup = useSetup();
    const [token, setToken] = useState(linkToken);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [again, setAgain] = useState("");
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (password === again) {
            setup.mutate({ token: token.trim(), email, password });
        }
    };
    return (
        <form onSubmit={submit}>
            <FieldGroup>
                {!linkToken && (
                    <Field
                        id="setup-token"
                        label={
                            <span className="flex items-center gap-1.5">
                                Setup token
                                <InfoTip label="What is the setup token?">
                                    {SETUP_TOKEN_INFO}
                                </InfoTip>
                            </span>
                        }
                        hint="The part after token= in the setup link."
                    >
                        <Input
                            id="setup-token"
                            className="font-mono"
                            autoComplete="off"
                            spellCheck={false}
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            required
                            autoFocus
                        />
                    </Field>
                )}
                <Field id="admin-email" label="Email">
                    <Input
                        id="admin-email"
                        type="email"
                        autoComplete="username"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        required
                        autoFocus={Boolean(linkToken)}
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
                    {setup.isPending ? "Creating…" : "Create admin account"}
                </Button>
            </FieldGroup>
        </form>
    );
}

export function SetupPage() {
    const [linkToken] = useState(tokenFromQuery);
    return (
        <AuthFrame
            title="Welcome to minibrain"
            description={
                <span className="flex flex-col gap-2">
                    <span>
                        Train, evaluate and serve models of any size on your own data and your own
                        hardware.
                    </span>
                    <span>
                        {linkToken
                            ? "Create the admin account to get started. You can invite everyone else later from Settings, Accounts."
                            : "Create the admin account to get started, with the setup token minibrain printed in its log when it started."}
                    </span>
                </span>
            }
            footer={
                <div className="flex flex-col gap-1">
                    <span>Lost the link? Run this on the server for a new one:</span>
                    <code className="font-mono">minibrain admin setup-link</code>
                </div>
            }
        >
            <div className="flex flex-col gap-5">
                <InsecureNotice />
                <AdminForm linkToken={linkToken} />
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
