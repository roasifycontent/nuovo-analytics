// Diagnostic endpoint — checks env var presence + tests Shopify auth
// Never exposes the full token, only the first 7 chars so we can verify the format

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  const out = {
    env: {
      SHOPIFY_STORE_DOMAIN: domain ? domain : '(NOT SET)',
      SHOPIFY_ACCESS_TOKEN_prefix: token ? token.slice(0, 7) + '...' : '(NOT SET)',
      SHOPIFY_ACCESS_TOKEN_length: token ? token.length : 0,
      SHOPIFY_ACCESS_TOKEN_starts_with_shpat: token ? token.startsWith('shpat_') : false,
      SHOPIFY_ACCESS_TOKEN_has_whitespace: token ? /\s/.test(token) : false
    }
  };

  if (!domain || !token) {
    out.error = 'Missing env vars';
    res.status(500).json(out);
    return;
  }

  // Test 1: shop.json (basic auth check — needs no scopes)
  try {
    const r = await fetch(`https://${domain}/admin/api/2024-10/shop.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    out.shop_test = { status: r.status };
    if (r.ok) {
      const data = await r.json();
      out.shop_test.name = data.shop && data.shop.name;
      out.shop_test.domain = data.shop && data.shop.myshopify_domain;
    } else {
      const txt = await r.text();
      out.shop_test.error = txt.slice(0, 300);
    }
  } catch (e) {
    out.shop_test = { error: e.message };
  }

  // Test 2: Simple GraphQL ping
  try {
    const r = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ shop { name } }' })
    });
    out.graphql_test = { status: r.status };
    const data = await r.json();
    if (data.errors) out.graphql_test.errors = data.errors;
    if (data.data) out.graphql_test.shop = data.data.shop;
    // Access scopes test
    const scopesR = await fetch(`https://${domain}/admin/oauth/access_scopes.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    if (scopesR.ok) {
      const scopesData = await scopesR.json();
      out.granted_scopes = (scopesData.access_scopes || []).map(s => s.handle);
    }
  } catch (e) {
    out.graphql_test = { error: e.message };
  }

  res.status(200).json(out);
};
