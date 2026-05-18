// Shopify Orders API — fetches orders within a date range, handles GraphQL cursor pagination
// Env vars required on Vercel: SHOPIFY_STORE_DOMAIN, SHOPIFY_ACCESS_TOKEN

const API_VERSION = '2024-10';

const ORDERS_QUERY = `
query GetOrders($first: Int!, $after: String, $q: String!) {
  orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        name
        createdAt
        processedAt
        displayFinancialStatus
        displayFulfillmentStatus
        currencyCode
        customer { firstName lastName email }
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        currentSubtotalPriceSet { shopMoney { amount currencyCode } }
        totalRefundedSet { shopMoney { amount currencyCode } }
        totalShippingPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        originalTotalPriceSet { shopMoney { amount } }
        lineItems(first: 25) {
          edges {
            node {
              title
              variantTitle
              quantity
              originalUnitPriceSet { shopMoney { amount } }
            }
          }
        }
        transactions(first: 10) {
          id
          kind
          status
          gateway
          createdAt
          amountSet { shopMoney { amount } }
          fees {
            amount { amount currencyCode }
            type
          }
        }
      }
    }
  }
}
`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!domain || !token) {
    res.status(500).json({ error: 'Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN env vars' });
    return;
  }

  // Parse query params: startDate, endDate (YYYY-MM-DD)
  const url = new URL(req.url, `https://${req.headers.host}`);
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');

  if (!startDate || !endDate) {
    res.status(400).json({ error: 'startDate and endDate required (YYYY-MM-DD)' });
    return;
  }

  try {
    const filter = `created_at:>='${startDate}T00:00:00Z' AND created_at:<='${endDate}T23:59:59Z'`;
    const allOrders = [];
    let after = null;
    let pageCount = 0;
    const MAX_PAGES = 40; // safety limit: 40 * 100 = 4000 orders

    while (pageCount < MAX_PAGES) {
      pageCount++;
      const variables = { first: 100, after, q: filter };

      const r = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: ORDERS_QUERY, variables })
      });

      if (!r.ok) {
        const errText = await r.text();
        res.status(r.status).json({ error: `Shopify ${r.status}: ${errText.slice(0, 500)}` });
        return;
      }

      const data = await r.json();
      if (data.errors) {
        res.status(500).json({ error: 'Shopify GraphQL errors', details: data.errors });
        return;
      }

      const ordersData = data.data && data.data.orders;
      if (!ordersData) break;

      ordersData.edges.forEach(e => allOrders.push(e.node));

      if (!ordersData.pageInfo.hasNextPage) break;
      after = ordersData.pageInfo.endCursor;
    }

    res.status(200).json({ orders: allOrders, count: allOrders.length, pages: pageCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
