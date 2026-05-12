const { GoogleAuth } = require('google-auth-library');

const PROPERTY_ID = '346978985';

const KEY = {
  "type": "service_account",
  "project_id": "elite-rider-496109-m3",
  "private_key_id": "REPLACE_WITH_YOUR_KEY_ID",
  "private_key": "REPLACE_WITH_YOUR_PRIVATE_KEY",
  "client_email": "nuovo-dash@elite-rider-496109-m3.iam.gserviceaccount.com",
  "client_id": "REPLACE",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token"
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const auth = new GoogleAuth({
      credentials: KEY,
      scopes: ['https://www.googleapis.com/auth/analytics.readonly']
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const body = req.body;
    const url = `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json(data);
      return;
    }
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
