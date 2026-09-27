// ominipaid-bsc telegram bot - cloudflare worker
import { HDNodeWallet, Interface, isAddress, getAddress, parseUnits, formatUnits } from 'ethers';

// ============ Config ============
const CHAIN_ID = 56;
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const RPCS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.binance.org/',
];

const IFACE = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const HELP = [
  '💰 OmniPaid Bot (BSC USDT)',
  '',
  'Commands (sirf admin):',
  '/pay <address> <amount> - USDT bhejo (confirm button ke saath)',
  '/balance - wallet balance',
  '/help - ye menu',
].join('\n');

const AMOUNT_RE = /^\d+(\.\d+)?$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _wallet = null;
let _payLock = false;

// ============ RPC / Telegram ============
async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) throw new Error('http ' + res.status);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'rpc error');
      return json.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(json.description || method + ' failed');
  return json.result;
}

const reply = (env, chatId, text, extra) =>
  tg(env, 'sendMessage', { chat_id: chatId, text, ...(extra || {}) });

// ============ Wallet (index 0) ============
function getWallet(env) {
  if (_wallet) return _wallet;
  const phrase = (env.PAY_WALLET_SECRET || '').trim();
  if (phrase.split(/\s+/).length !== 12) {
    throw new Error('PAY_WALLET_SECRET (12 words) secret set nahi hai');
  }
  _wallet = HDNodeWallet.fromPhrase(phrase, undefined, "m/44'/60'/0'/0/0");
  return _wallet;
}

async function usdtBalance(owner) {
  const data = IFACE.encodeFunctionData('balanceOf', [owner]);
  return BigInt(await rpc('eth_call', [{ to: USDT, data }, 'latest']));
}

const isAdmin = (env, user) =>
  !!user && String(user.id) === String(env.ADMIN_ID || '').trim();

// ============ Payment ============
async function executePay(env, chatId, to, amt) {
  if (_payLock) return reply(env, chatId, '⏳ Pehli wali pay abhi chal rahi hai, ruko');
  _payLock = true;
  try {
    const wallet = getWallet(env);
    const value = parseUnits(amt, 18);

    const bal = await usdtBalance(wallet.address);
    if (bal < value) {
      return reply(env, chatId, `❌ Kam balance: ${formatUnits(bal, 18)} USDT hai, ${amt} chahiye`);
    }
    const bnb = BigInt(await rpc('eth_getBalance', [wallet.address, 'latest']));
    if (bnb === 0n) {
      return reply(env, chatId, '❌ Gas (BNB) nahi hai wallet me');
    }

    const data = IFACE.encodeFunctionData('transfer', [getAddress(to), value]);
    const [nonceHex, gasPriceHex] = await Promise.all([
      rpc('eth_getTransactionCount', [wallet.address, 'latest']),
      rpc('eth_gasPrice', []),
    ]);

    let gasLimit = 100000n;
    try {
      const est = BigInt(await rpc('eth_estimateGas', [{ from: wallet.address, to: USDT, data }]));
      gasLimit = (est * 12n) / 10n;
    } catch {}

    const raw = await wallet.signTransaction({
      type: 0,
      chainId: CHAIN_ID,
      to: USDT,
      nonce: Number(BigInt(nonceHex)),
      gasPrice: BigInt(gasPriceHex),
      gasLimit,
      data,
    });
    const hash = await rpc('eth_sendRawTransaction', [raw]);

    await reply(env, chatId, `⏳ Tx broadcast\nHash: ${hash}\n⏳ Confirm ho rahi hai...`);

    let receipt = null;
    for (let i = 0; i < 6 && !receipt; i++) {
      await sleep(3000);
      receipt = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    }

    if (!receipt) {
      return reply(
        env,
        chatId,
        `⏳ Confirm late ho rahi hai, ye link check karo:\nhttps://bscscan.com/tx/${hash}`
      );
    }
    if (receipt.status === '0x1') {
      await reply(
        env,
        chatId,
        `✅ paid | index 0 | ${amt} USDT -> ${to}\n🔗 https://bscscan.com/tx/${hash}`
      );
    } else {
      await reply(env, chatId, `❌ Tx revert ho gayi\nhttps://bscscan.com/tx/${hash}`);
    }
  } finally {
    _payLock = false;
  }
}

// ============ Handlers ============
async function handleMessage(update, env) {
  const msg = update.message;
  if (!msg || typeof msg.text !== 'string' || !msg.from || msg.from.is_bot) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].split('@')[0];
  const admin = isAdmin(env, msg.from);

  if (cmd === '/start' || cmd === '/help') {
    if (admin) return reply(env, chatId, HELP);
    return reply(env, chatId, `❌ Tum admin nahi ho.\nAapka Telegram ID: ${msg.from.id}`);
  }

  if (!admin) {
    return reply(env, chatId, `❌ Sirf admin hi pay kar sakta hai.\nAapka ID: ${msg.from.id}`);
  }

  if (cmd === '/balance' || cmd === '/bal') {
    const wallet = getWallet(env);
    const [bal, bnb] = await Promise.all([
      usdtBalance(wallet.address),
      rpc('eth_getBalance', [wallet.address, 'latest']).then((r) => BigInt(r)),
    ]);
    return reply(
      env,
      chatId,
      `💳 Wallet (index 0)\n${wallet.address}\n\nUSDT: ${formatUnits(bal, 18)}\nBNB: ${formatUnits(bnb, 18)}`
    );
  }

  if (cmd === '/pay') {
    const to = parts[1];
    const amt = parts[2];
    if (!to || !amt) {
      return reply(env, chatId, 'Usage:\n/pay <address> <amount>\nJaise:\n/pay 0x1234... 10.5');
    }
    if (!isAddress(to)) return reply(env, chatId, '❌ Address galat hai');
    if (!AMOUNT_RE.test(amt)) return reply(env, chatId, '❌ Amount galat hai (jaise 10.5)');
    if (amt.length > 18) return reply(env, chatId, '❌ Amount bohot lamba hai');

    let value;
    try {
      value = parseUnits(amt, 18);
    } catch {
      return reply(env, chatId, '❌ Amount galat hai');
    }
    if (value <= 0n) return reply(env, chatId, '❌ Amount 0 nahi ho sakta');

    const wallet = getWallet(env);
    const bal = await usdtBalance(wallet.address);
    if (bal < value) {
      return reply(env, chatId, `❌ Kam balance: ${formatUnits(bal, 18)} USDT hai, ${amt} chahiye`);
    }
    const bnb = BigInt(await rpc('eth_getBalance', [wallet.address, 'latest']));
    if (bnb === 0n) return reply(env, chatId, '❌ Gas (BNB) nahi hai wallet me');

    return reply(
      env,
      chatId,
      `Confirm karo:\n\nTo: ${getAddress(to)}\nAmount: ${amt} USDT\nFrom: index 0 (${wallet.address})`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ SEND', callback_data: `p:${to.toLowerCase()}:${amt}` },
              { text: '❌ CANCEL', callback_data: 'cancel' },
            ],
          ],
        },
      }
    );
  }

  return reply(env, chatId, HELP);
}

async function handleCallback(update, env) {
  const cb = update.callback_query;
  if (!cb || !cb.from) return;

  const chatId = (cb.message && cb.message.chat && cb.message.chat.id) || cb.from.id;
  const data = cb.data || '';
  const ack = (text, alert) =>
    tg(env, 'answerCallbackQuery', {
      callback_query_id: cb.id,
      text,
      show_alert: !!alert,
    }).catch(() => {});

  if (!isAdmin(env, cb.from)) return ack('❌ Sirf admin hi pay kar sakta hai', true);

  if (data === 'cancel') {
    await ack('❌ Cancel ho gaya');
    if (cb.message) {
      await tg(env, 'editMessageText', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: '❌ Cancelled - koi paisa nahi gaya',
      }).catch(() => {});
    }
    return;
  }

  if (!data.startsWith('p:')) return ack('❓ Samajh nahi aaya', true);

  const [, to, amt] = data.split(':');
  if (!isAddress(to) || !AMOUNT_RE.test(amt)) return ack('❌ Data galat hai', true);

  await ack('⏳ Bhej rahe hain...');
  if (cb.message) {
    await tg(env, 'editMessageText', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: `⏳ Sending ${amt} USDT -> ${to} ...`,
    }).catch(() => {});
  }

  try {
    await executePay(env, chatId, to, amt);
  } catch (e) {
    await reply(env, chatId, `❌ Fail: ${e.message}`).catch(() => {});
  }
}

async function handleUpdate(update, env) {
  try {
    getWallet(env);
  } catch (e) {
    console.error('wallet init:', e.message);
  }
  if (update.callback_query) return handleCallback(update, env);
  if (update.message) return handleMessage(update, env);
}

// ============ Worker ============
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      try {
        getWallet(env);
      } catch {}
      return new Response('ominipaid-bot ok');
    }
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

    if (env.WEBHOOK_SECRET) {
      const got = request.headers.get('x-telegram-bot-api-secret-token');
      if (got !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('bad json', { status: 400 });
    }

    ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error('update fail:', e.message)));
    return new Response('ok');
  },
};
