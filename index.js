const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const twilioLib = require('twilio'); // simpler, reliable import

const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(bodyParser.json());

// ---- Env ----
const {
  PORT = 3000,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  PIPEDRIVE_API_TOKEN,
  PIPEDRIVE_BASE = 'https://api.pipedrive.com/v1',
  SLACK_WEBHOOK_URL
} = process.env;

// Clients
const twilio = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const pd = axios.create({ baseURL: PIPEDRIVE_BASE, params: { api_token: PIPEDRIVE_API_TOKEN } });

// -------- Helpers --------
async function findPersonByPhone(phone) {
  if (!phone) return null;

  const original = String(phone).trim();
  const digits = original.replace(/\D/g, '');

  // try multiple formats so we match numbers saved as 480-xxx-xxxx, (480) xxx-xxxx, etc.
  const candidates = [];
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    candidates.push(last10);        // 4805551234
    candidates.push('+1' + last10); // +14805551234
    candidates.push('1' + last10);  // 14805551234
  }
  if (original.startsWith('+')) candidates.push(original);

  const uniq = [...new Set(candidates)];
  for (const term of uniq) {
    try {
      const { data } = await pd.get('/persons/search', {
        params: { term, fields: 'phone', exact_match: false, limit: 1 }
      });
      const item = data?.data?.items?.[0]?.item;
      if (item) return item;
    } catch (_) {}
  }
  return null;
}

async function createPersonForPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  const last10 = digits.slice(-10);
  const e164 = (digits.length === 11 && digits.startsWith('1')) ? ('+' + digits) : ('+1' + last10);

  const payload = {
    name: e164, // you can rename later
    phone: [
      { value: e164, primary: true, label: 'mobile' },
      { value: last10, primary: false, label: 'alt' }
    ]
  };

  const { data } = await pd.post('/persons', payload);
  return data?.data || null;
}

async function getPrimaryDealForPerson(personId) {
  const { data } = await pd.get(`/persons/${personId}/deals`, { params: { status: 'open', limit: 1 } });
  return (data && data.data && data.data[0]) || null;
}

async function logNote({ content, personId, dealId }) {
  return pd.post('/notes', {
    content,
    person_id: personId || undefined,
    deal_id: dealId || undefined
  });
}

async function notify(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try { await axios.post(SLACK_WEBHOOK_URL, { text }); } catch (_) {}
}

// -------- Health check --------
app.get('/health', (req, res) => res.send('ok'));

// -------- Inbound SMS (Twilio webhook) --------
app.post('/inbound', async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body || '';
    const mediaCount = Number(req.body.NumMedia || 0);

    let person = await findPersonByPhone(from);
    if (!person) person = await createPersonForPhone(from); // auto-create if missing

    const deal = person ? await getPrimaryDealForPerson(person.id) : null;

    await logNote({
      content: `[SMS In] ${new Date().toLocaleString()} – ${body}${mediaCount ? ' (MMS attached)' : ''}`,
      personId: person?.id,
      dealId: deal?.id
    });

    await notify(`📲 New SMS from ${from}${person ? ` (${person.name || ''})` : ''}: ${body}`);
    res.type('text/xml').send('<Response/>'); // minimal TwiML response
  } catch (e) {
    console.error(e);
    res.status(500).send('error');
  }
});

// -------- Simple send form (opens from Pipedrive link) --------
app.get('/send-form', (req, res) => {
  const { phone = '', person_id = '', deal_id = '' } = req.query;
  res.send(`
    <html><body style="font-family: sans-serif; max-width: 440px; margin: 40px auto;">
      <h3>Send SMS</h3>
      <form method="POST" action="/send">
        <label>To</label><br/>
        <input name="to" value="${phone}" style="width:100%;padding:8px"/><br/><br/>
        <label>Message</label><br/>
        <textarea name="message" rows="5" style="width:100%;padding:8px"></textarea><br/><br/>
        <input type="hidden" name="personId" value="${person_id}"/>
        <input type="hidden" name="dealId" value="${deal_id}"/>
        <button type="submit" style="padding:10px 16px;">Send</button>
      </form>
    </body></html>
  `);
});

// -------- Outbound send --------
app.post('/send', async (req, res) => {
  try {
    const { to, message, personId, dealId } = req.body;
    const msg = await twilio.messages.create({ to, from: TWILIO_NUMBER, body: message });

    await logNote({
      content: `[SMS Out] ${new Date().toLocaleString()} – "${message}"`,
      personId, dealId
    });

    res.json({ ok: true, sid: msg.sid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => console.log(`pd-sms running on :${PORT}`));
