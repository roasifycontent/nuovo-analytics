// Step 1 of OAuth: redirect to Shopify authorize endpoint
// Required env: SHOPIFY_CLIENT_ID

const SCOPES = 'read_orders,read_all_orders,read_products,read_customers';

module.exports = async (req, res) => {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('Missing SHOPIFY_CLIENT_ID env var. Add it in Vercel settings.');
    return;
  }
  const url = new URL(req.url, `https://${req.headers.host}`);
  const shop = url.searchParams.get('shop');
  if (!shop || !shop.endsWith('.myshopify.com')) {
    res.status(400).send('Pass ?shop=xxx.myshopify.com');
    return;
  }
  const state = Math.random().toString(36).slice(2, 18);
  const redirectUri = `https://${req.headers.host}/api/shopify-callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
    'grant_options[]': ''
  });
  res.setHeader('Set-Cookie', `shop_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  res.writeHead(302, { Location: `https://${shop}/admin/oauth/authorize?${params}` });
  res.end();
};
