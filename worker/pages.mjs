// The HTML the Worker serves. The privacy policy states what the code does; change it with the code.
const CONTACT = 'cheongziann@gmail.com'

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const layout = (title, body) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${title}</title>
<body style="font:16px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
${body}`

const html = (body) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })

export function homepage(request) {
  const connector = escape(new URL('/mcp', request.url).href)
  return html(layout('Docs MCP', `<h1>Docs MCP</h1>
<p>Docs MCP is an MCP server that lets AI assistants such as Claude read and edit the Google Docs
you choose. Add it to your assistant as a custom connector, then sign in with your Google account.</p>
<p>Connector URL: <code>${connector}</code></p>
<p><a href="/privacy">Privacy policy</a> · Contact: <a href="mailto:${CONTACT}">${CONTACT}</a></p>`))
}

export function privacyPolicy() {
  return html(layout('Docs MCP privacy policy', `<h1>Docs MCP privacy policy</h1>
<p>Effective 15 October 2026.</p>

<h2>What Docs MCP accesses</h2>
<p>When you sign in, Google gives Docs MCP your Google account ID and permission to read and edit
your Google Docs, and to create and change files in your Google Drive that Docs MCP itself created.
It does not ask for your name, email address or any other Drive files.</p>
<p>Docs MCP reads or changes a document only when your assistant calls one of its tools on that
document. The content a tool reads is returned to the assistant you connected, such as Claude,
which handles it under its own terms.</p>

<h2>What is stored, and where</h2>
<p>Docs MCP runs on Cloudflare Workers and stores data in Cloudflare Workers KV:</p>
<ul>
<li><strong>Google sign-in tokens.</strong> Your Google access and refresh tokens are kept in an
encrypted sign-in record, which expires 30 days after you connect. If you revoke Docs MCP's access
in your Google account, the tokens stop working at once, and the record is deleted the next time
your assistant tries to renew it.</li>
<li><strong>Document snapshots.</strong> After Docs MCP changes a document, or when your
assistant asks it to re-sync one, it stores a copy of that document's text, filed under your
Google account ID. The copy is used only to detect edits made in the document since then, so that
Docs MCP does not overwrite them. Snapshots are kept indefinitely, until you ask for them to be
deleted.</li>
</ul>
<p>Docs MCP does not log document content.</p>

<h2>Sharing</h2>
<p>Your data is not sold, not shared with anyone other than the assistant you connect, and not
used for advertising or to train AI models. Cloudflare hosts the service and stores the data
described above.</p>

<h2>Revoking access and deleting your data</h2>
<p>Remove Docs MCP's access at any time on your
<a href="https://myaccount.google.com/permissions">Google account permissions page</a>, and remove
the connector from your assistant. To have your stored snapshots deleted, email
<a href="mailto:${CONTACT}">${CONTACT}</a>.</p>

<h2>Google API Services User Data Policy</h2>
<p>Docs MCP's use and transfer to any other app of information received from Google APIs will
adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google
API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>`))
}

// The client's name and redirect come from dynamic registration, so an attacker picks them: escape both.
export function consentPage(client, handle) {
  const name = escape(client.clientName)
  return layout(`Connect ${name} to Google Docs`, `<h1>Allow ${name} to read and edit your Google Docs?</h1>
<p>Access will be sent to <strong>${escape(client.redirectHost)}</strong>. The app named itself; that name is not verified.</p>
${client.redirectIsLoopback ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
<p>Google will then ask you to sign in and approve access to your documents.</p>
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="allow">Continue to Google</button>
<button name="decision" value="deny">Cancel</button>
</form>`)
}
