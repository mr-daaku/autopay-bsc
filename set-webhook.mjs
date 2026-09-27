// node set-webhook.mjs https://ominipaid-bot.xxx.workers.dev
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const workerUrl = process.argv[2];
if (!workerUrl) {
  console.error('Usage: node set-webhook.mjs https://<worker>.workers.dev');
  process.exit(1);
}
if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
  console.error('.env me BOT_TOKEN / WEBHOOK_SECRET nahi hai');
  process.exit(1);
}

async function api(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

const me = await api('getMe', {});
console.log(`🤖 Bot: @${me.username} (${me.first_name})`);

const ok = await api('setWebhook', {
  url: workerUrl,
  secret_token: env.WEBHOOK_SECRET,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
});
console.log('setWebhook:', ok);

const info = await api('getWebhookInfo', {});
console.log('webhook url :', info.url);
console.log('pending     :', info.pending_update_count);
if (info.last_error_message) console.log('last error  :', info.last_error_message);
