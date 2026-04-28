/**
 * Shown when the Worker reports that Cloudflare Access is not yet configured.
 * Walks the user through wiring up Access and setting the two vars. SPEC §16.1.
 */

import { useAuth } from '../lib/store';

export function PostDeploySetup({ hint }: { hint: string }) {
  const refresh = useAuth((s) => s.refresh);
  return (
    <main className="setup">
      <header>
        <h1>🎼 Welcome to Philharmonic</h1>
        <p className="subtitle">One last step before you can sign in.</p>
      </header>

      <section>
        <h2>1. Add Cloudflare Access in front of this Worker</h2>
        <p>
          Open the Cloudflare dashboard → <strong>Zero Trust</strong> →{' '}
          <strong>Access → Applications → Add an application</strong>.
        </p>
        <ul>
          <li>
            <strong>Type:</strong> Self-hosted
          </li>
          <li>
            <strong>Application URL:</strong> the hostname of this Worker
          </li>
          <li>
            <strong>Identity providers:</strong> at least one (Google, GitHub, email OTP — your call)
          </li>
        </ul>
      </section>

      <section>
        <h2>2. Copy the Access team domain and audience tag</h2>
        <p>
          From <em>Settings → Custom Pages → Login URL</em> grab the team domain
          (looks like <code>https://your-team.cloudflareaccess.com</code>). From the application's
          <em> overview tab</em> copy the AUD tag (a long hex string).
        </p>
      </section>

      <section>
        <h2>3. Set the vars and re-deploy</h2>
        <pre>
{`# wrangler.jsonc → vars
"ACCESS_TEAM_DOMAIN": "https://your-team.cloudflareaccess.com",
"ACCESS_AUD": "your_application_aud_tag"

pnpm deploy`}
        </pre>
      </section>

      <section className="hint">
        <strong>Server hint:</strong> {hint}
      </section>

      <button onClick={refresh} type="button">
        I'm done — re-check
      </button>
    </main>
  );
}
