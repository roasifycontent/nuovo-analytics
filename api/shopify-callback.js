// Step 2 of OAuth: exchange the code for an admin API access token
// Required env: SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET

module.exports = async (req, res) => {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).send('Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET env var.');
    return;
  }
  const url = new URL(req.url, `https://${req.headers.host}`);
  const shop = url.searchParams.get('shop');
  const code = url.searchParams.get('code');
  if (!shop || !code) {
    res.status(400).send('Missing shop or code param.');
    return;
  }
  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      res.status(500).send(`<h1>Token exchange failed</h1><pre>${JSON.stringify(data, null, 2)}</pre>`);
      return;
    }
    const token = data.access_token;
    const scope = data.scope || '';
    const masked = token.slice(0, 10) + '...' + token.slice(-6);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`
<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><title>Token captured</title>
<style>
body{font-family:-apple-system,sans-serif;background:#0a0a0b;color:#f0efe8;padding:40px;line-height:1.6;max-width:760px;margin:0 auto}
h1{color:#d4a843}
code,pre{background:#17171a;border:0.5px solid rgba(255,255,255,0.12);border-radius:6px;padding:14px;display:block;font-family:'DM Mono',monospace;font-size:13px;word-break:break-all;color:#10b981;margin:14px 0}
.warn{background:rgba(212,168,67,0.1);border:0.5px solid rgba(212,168,67,0.4);border-radius:8px;padding:14px 18px;margin:18px 0}
ol li{margin-bottom:8px}
a{color:#d4a843}
button{background:#d4a843;color:#0a0a0b;border:none;border-radius:6px;padding:10px 20px;cursor:pointer;font-size:14px;font-weight:600}
</style>
</head><body>
<h1>✓ Got your Admin API access token</h1>
<p>Shop: <strong>${shop}</strong></p>
<p>Granted scopes: <code>${scope}</code></p>

<h2>Copy this token:</h2>
<code id="token">${token}</code>
<button onclick="navigator.clipboard.writeText(document.getElementById('token').textContent);this.textContent='Copied ✓'">Copy to clipboard</button>

<div class="warn">
<strong>⚠ Important:</strong> This token will not be shown again. Copy it now.
</div>

<h2>Next steps</h2>
<ol>
<li>Go to <a href="https://vercel.com/dashboard" target="_blank">Vercel</a> → your project → Settings → Environment Variables</li>
<li><strong>Edit</strong> the <code style="display:inline;padding:2px 8px;color:#f0efe8">SHOPIFY_ACCESS_TOKEN</code> variable</li>
<li>Replace its value with the token above (starts with <code style="display:inline;padding:2px 8px;color:#f0efe8">shpat_</code>)</li>
<li>Click <strong>Save</strong></li>
<li>Go to <strong>Deployments</strong> → click ⋯ on latest → <strong>Redeploy</strong> (uncheck "Use existing build cache")</li>
<li>Test by visiting <a href="/api/shopify-test">/api/shopify-test</a> — should show shop_test.status = 200</li>
<li>Then visit <a href="/profit">/profit</a> — orders will load</li>
</ol>

<p style="margin-top:30px;color:#a8a49e;font-size:12px">Token preview (for confirmation): ${masked}</p>
</body></html>
    `);
  } catch (e) {
    res.status(500).send(`<h1>Error</h1><pre>${e.message}</pre>`);
  }
};
