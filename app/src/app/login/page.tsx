import { redirect } from "next/navigation";
import { isAuthEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * A plain form, posting straight to /api/auth/login.
 *
 * No client component and no JavaScript: this is the one page that has to work
 * before anything else does, and a hydration error here would lock you out of
 * your own desk with no way back in. The browser submits it natively.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  // With no door fitted there is nothing to sign in to.
  if (!isAuthEnabled()) redirect("/");

  const { error, next } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-16">
      <div className="w-full max-w-[320px]">
        <h1 className="font-display text-[17px] font-extrabold tracking-tight">Nifty 200 Desk</h1>
        <p className="mt-1 text-[12.5px] text-muted">Sign in to continue.</p>

        <form action="/api/auth/login" method="POST" className="mt-6 flex flex-col gap-3">
          {next ? <input type="hidden" name="next" value={next} /> : null}

          <label className="flex flex-col gap-1.5">
            <span className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
              Email
            </span>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              className="rounded-[3px] border border-linestrong bg-surface px-2.5 py-2 text-[13px] outline-none focus:border-accent"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
              Password
            </span>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="rounded-[3px] border border-linestrong bg-surface px-2.5 py-2 text-[13px] outline-none focus:border-accent"
            />
          </label>

          {error ? (
            <p role="alert" className="text-[12px] text-alert">
              Invalid email or password.
            </p>
          ) : null}

          <button
            type="submit"
            className="mt-1 rounded-[3px] border border-linestrong bg-surface px-3 py-2 text-[12.5px] font-semibold hover:border-accent"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
