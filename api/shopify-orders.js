// Shopify Orders API — fetches orders within a date range, handles GraphQL cursor pagination
// Env vars required on Vercel: SHOPIFY_STORE_DOMAIN, SHOPIFY_ACCESS_TOKEN

const API_VERSION = '2024-10';
const TZ = 'Europe/London';

// Convert a UK-local YYYY-MM-DD date to a UTC ISO instant for the start (00:00:00)
// or end (23:59:59.999) of that UK day. Handles BST/GMT automatically.
function ukDayBoundUtc(ymd, isEnd) {
  // Find UK offset from UTC at this date by probing noon UTC and reading the UK hour.
  // Noon avoids DST transition edge cases at midnight.
  const probe = new Date(`${ymd}T12:00:00Z`);
  const ukHourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', hour12: false
  }).formatToParts(probe).find(p => p.type === 'hour').value;
  const ukHour = parseInt(ukHourStr, 10);
  const offsetHours = ukHour - 12; // 1 in BST, 0 in GMT
  const base = new Date(`${ymd}T${isEnd ? '23:59:59.999' : '00:00:00.000'}Z`);
  base.setUTCHours(base.getUTCHours() - offsetHours);
  return base.toISOString();
}

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
        tags
        customerJourneySummary {
          firstVisit {
            source
            sourceType
            referrerUrl
            utmParameters {
              source
              medium
              campaign
            }
          }
        }
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
              currentQuantity
              originalUnitPriceSet { shopMoney { amount } }
              discountedTotalSet { shopMoney { amount } }
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
  // Orders change in real time (edits, refunds, fulfilment) — never serve stale.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
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
    // Use UK-local day bounds (handles BST/GMT). Orders placed at 00:30 BST on
    // May 19 (= 23:30 UTC May 18) are correctly attributed to May 19.
    const startUtc = ukDayBoundUtc(startDate, false);
    const endUtc = ukDayBoundUtc(endDate, true);
    const filter = `created_at:>='${startUtc}' AND created_at:<='${endUtc}'`;
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

      ordersData.edges.forEach(e => {
        const o = e.node;
        // Reflect Shopify order edits: currentQuantity is the truthful post-edit
        // count (a removed line item is 0). Consumers read `quantity`, so remap it
        // to currentQuantity — otherwise removed items still count as sold.
        if (o.lineItems && o.lineItems.edges) {
          o.lineItems.edges.forEach(le => {
            if (le.node && le.node.currentQuantity != null) le.node.quantity = le.node.currentQuantity;
          });
        }
        allOrders.push(o);
      });

      if (!ordersData.pageInfo.hasNextPage) break;
      after = ordersData.pageInfo.endCursor;
    }

    res.status(200).json({ orders: allOrders, count: allOrders.length, pages: pageCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
