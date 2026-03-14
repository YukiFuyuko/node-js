/**
 * join.js
 *
 * Multi-bot manager — live terminal dashboard (bots table only).
 * All logs go to logs/bots.log instead of the screen.
 *
 * Usage:
 *   node join.js
 *   node join.js --count 10
 *   node join.js --name Scout
 *   node join.js --count 5 --name Bot
 *
 * Controls: UP/DOWN scroll | Q quit
 * Logs:     tail -f logs/bots.log
 *
 * Install: npm install mineflayer blessed
 */

'use strict';

const mineflayer = require('mineflayer');
const blessed    = require('blessed');
const fs         = require('fs');
const path       = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const HOST            = 'play.claritynet.work';
const PORT            = 25565;
const VERSION         = '1.21.11';
const BASE_NAME       = 'nemesis';
const RECONNECT_DELAY = 10000;
const STAGGER_DELAY   = 5000;

// ── File logger ───────────────────────────────────────────────────────────────
// All output goes here — nothing is ever written to the terminal directly.
const LOG_DIR  = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bots.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function flog(line) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  // Strip blessed colour tags before writing to file
  const plain = line.replace(/\{[^}]+\}/g, '');
  logStream.write(`[${ts}] ${plain}\n`);
}

function blog(state, line) {
  flog(`[${state.username}] ${line}`);
}

// Redirect console so any stray mineflayer output goes to file too
console.log  = (...a) => flog(a.join(' '));
console.warn = (...a) => flog('[WARN] ' + a.join(' '));
console.error= (...a) => flog('[ERR]  ' + a.join(' '));

// ── CLI args ──────────────────────────────────────────────────────────────────
//
// Modes (pick one):
//
//   (default)                     Auto-increment from BASE_NAME
//                                 e.g. AIBot1, AIBot2, AIBot3 ...
//
//   --count <n>                   Run n bots with auto-incremented names
//                                 e.g. node join.js --count 10
//
//   --random <prefix> <count>     Sequential suffix from counter, custom prefix
//                                 e.g. node join.js --random Bot 10
//                                 -> Bot1, Bot2 ... Bot10
//
//   --player <n1> <n2> ...        Exact names, no prefix/suffix.
//                                 Bot count = number of names given.
//                                 e.g. node join.js --player Alex Steve Notch
//                                 -> Alex, Steve, Notch (3 bots)
//
// --random and --player cannot be combined.

const ARGS = process.argv.slice(2);

function argIndex(flag) { return ARGS.indexOf(flag); }

// ── Counter file (used by default mode and --random) ─────────────────────────
const COUNTER_FILE = path.join(__dirname, 'bot_counter.json');

function getNextCounter(base) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')); } catch {}
  const n = (c[base] ?? 0) + 1;
  c[base] = n;
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(c, null, 2));
  return n;
}

// ── Username resolution ───────────────────────────────────────────────────────
function resolveUsernames() {
  // ── --player <name1> <name2> ... ─────────────────────────────────────────
  // Collect all values after --player until the next flag or end of args.
  const playerIdx = argIndex('--player');
  if (playerIdx !== -1) {
    const names = [];
    for (let i = playerIdx + 1; i < ARGS.length; i++) {
      if (ARGS[i].startsWith('--')) break;   // stop at next flag
      names.push(ARGS[i].slice(0, 16));
    }
    if (names.length === 0) {
      flog('ERROR: --player requires at least one name. e.g. --player Alex Steve');
      process.exit(1);
    }
    flog(`Mode: --player  names: ${names.join(', ')}`);
    return names;
  }

  // ── --random <prefix> <count> ─────────────────────────────────────────────
  const randomIdx = argIndex('--random');
  if (randomIdx !== -1) {
    const prefix = ARGS[randomIdx + 1];
    const count  = parseInt(ARGS[randomIdx + 2], 10);
    if (!prefix || prefix.startsWith('--') || isNaN(count) || count < 1) {
      flog('ERROR: --random requires a prefix and a count. e.g. --random Bot 10');
      process.exit(1);
    }
    const base = prefix.replace(/\d+$/, '');
    const names = Array.from({ length: count }, () => (base + getNextCounter(base)).slice(0, 16));
    flog(`Mode: --random  prefix: ${base}  count: ${count}  names: ${names.join(', ')}`);
    return names;
  }

  // ── --count <n>  (default auto-increment) ────────────────────────────────
  const countIdx = argIndex('--count');
  const count    = countIdx !== -1 ? Math.max(1, parseInt(ARGS[countIdx + 1], 10) || 1) : 1;
  const base     = (process.env.BOT_NAME || BASE_NAME).replace(/\d+$/, '');
  const names    = Array.from({ length: count }, () => (base + getNextCounter(base)).slice(0, 16));
  flog(`Mode: auto-increment  base: ${base}  count: ${count}  names: ${names.join(', ')}`);
  return names;
}

// ── Bot state ─────────────────────────────────────────────────────────────────
const bots = new Map();

function makeBotState(username) {
  return {
    username,
    status     : 'connecting',
    health     : '--',
    food       : '--',
    pos        : '--',
    ping       : '--',
    uptime     : 0,
    uptimeTimer: null,
    connects   : 0,
    bot        : null,
  };
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function pad(val, len) {
  return String(val ?? '--').slice(0, len).padEnd(len);
}

// col widths: name, status, hp, food, ping, uptime, joins, position
const COLS = [15, 15, 4, 4, 7, 8, 5, 24];
const LABELS = ['NAME','STATUS','HP','FOOD','PING','UPTIME','JOINS','POSITION'];

function statusTag(s) {
  switch (s) {
    case 'online':       return '{green-fg}● online       {/}';
    case 'connecting':   return '{yellow-fg}◌ connecting   {/}';
    case 'reconnecting': return '{yellow-fg}↺ reconnecting {/}';
    case 'error':        return '{red-fg}✖ error        {/}';
    default:             return '{gray-fg}? unknown      {/}';
  }
}

function fmtUptime(s) {
  if (s < 60)   return pad(`${s}s`, COLS[5]);
  if (s < 3600) return pad(`${Math.floor(s/60)}m${s%60}s`, COLS[5]);
  return pad(`${Math.floor(s/3600)}h${Math.floor((s%3600)/60)}m`, COLS[5]);
}

function buildRows() {
  const lines = [];
  let i = 0;
  for (const s of bots.values()) {
    const alt = i++ % 2 === 0 ? '' : '{#1c1c1c-bg}';
    const end = alt ? '{/}' : '';
    const ping = s.ping !== '--' ? `${s.ping}ms` : '--';
    const row = [
      pad(s.username, COLS[0]),
      statusTag(s.status),
      pad(s.health,   COLS[2]),
      pad(s.food,     COLS[3]),
      pad(ping,       COLS[4]),
      fmtUptime(s.uptime),
      pad(s.connects, COLS[6]),
      pad(s.pos,      COLS[7]),
    ].join(' ');
    lines.push(alt + row + end);
  }
  return lines.join('\n');
}

// ── Terminal UI (bots table only — no log widget) ────────────────────────────
const screen = blessed.screen({
  smartCSR    : true,
  title       : 'MC Bot Monitor',
  fullUnicode : true,
  forceUnicode: true,
});

// Header: 1 row
const header = blessed.box({
  top: 0, left: 0,
  width: '100%', height: 1,
  tags : true,
  style: { bg: 'blue', fg: 'white', bold: true },
  padding: { left: 1 },
});
screen.append(header);

// Column labels: 1 row
const colBar = blessed.box({
  top: 1, left: 0,
  width: '100%', height: 1,
  tags: true,
  content: '{bold}{#005f87-bg}{white-fg} ' +
    LABELS.map((l, i) => pad(l, COLS[i])).join(' ') +
    ' {/}',
});
screen.append(colBar);

// Bot rows: fills the rest
const botsBox = blessed.box({
  top   : 2, left: 0,
  width : '100%',
  height: '100%-3',
  tags  : true,
  scrollable : true,
  alwaysScroll: true,
  keys  : true,
  vi    : true,
  mouse : true,
  border: { type: 'line' },
  label : ' {bold}{cyan-fg}Bots{/}{/} ',
  style : { border: { fg: 'cyan' } },
});
screen.append(botsBox);

// Footer: 1 row at very bottom
const footer = blessed.box({
  top  : '100%-1', left: 0,
  width: '100%', height: 1,
  tags : true,
  content: ' {gray-fg}UP/DN: scroll bots  |  Q: quit  |  logs: tail -f logs/bots.log{/}',
  style: { bg: '#111111' },
});
screen.append(footer);

// Keys
screen.key(['q', 'C-c'], () => { screen.destroy(); process.exit(0); });
screen.key(['up'],   () => { botsBox.scroll(-1); screen.render(); });
screen.key(['down'], () => { botsBox.scroll(1);  screen.render(); });
botsBox.focus();

// ── Render ────────────────────────────────────────────────────────────────────
let rendering = false;

function render() {
  if (rendering) return;
  rendering = true;
  try {
    const online = [...bots.values()].filter(s => s.status === 'online').length;
    const total  = bots.size;
    const mb     = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    const now    = new Date().toTimeString().slice(0, 8);
    header.setContent(
      `{bold}MC Bot Monitor{/}  ` +
      `{white-fg}Online: ${online}/${total}{/}  ` +
      `{cyan-fg}RAM: ${mb}MB{/}  ` +
      `{gray-fg}${now}  ${HOST}:${PORT}{/}`
    );
    botsBox.setContent(buildRows());
    screen.render();
  } finally {
    rendering = false;
  }
}

setInterval(render, 1000);

// ── Bot factory ───────────────────────────────────────────────────────────────
function connectBot(username) {
  let state = bots.get(username);
  if (!state) { state = makeBotState(username); bots.set(username, state); }

  state.status = 'connecting';
  state.health = '--';
  state.food   = '--';
  state.pos    = '--';
  state.ping   = '--';
  blog(state, `Connecting to ${HOST}:${PORT}...`);

  let bot;
  try {
    bot = mineflayer.createBot({
      host: HOST, port: PORT, username,
      version: VERSION, auth: 'offline',
      physicsEnabled: false,
    });
  } catch (e) {
    state.status = 'error';
    blog(state, `Failed to create bot: ${e.message}`);
    setTimeout(() => connectBot(username), RECONNECT_DELAY);
    return;
  }
  state.bot = bot;

  // RAM: wipe chunks
  bot.on('chunkColumnLoad', (pt) => {
    try { bot.world.unloadColumn(pt.x, pt.z); } catch {}
  });

  // RAM: wipe entities every 30s
  const entityTimer = setInterval(() => {
    try {
      for (const id of Object.keys(bot.entities)) {
        if (bot.entities[id] !== bot.entity) delete bot.entities[id];
      }
    } catch {}
  }, 30_000);

  const pingTimer = setInterval(() => {
    const self = bot.players?.[bot.username];
    if (self?.ping != null) state.ping = self.ping;
  }, 5000);

  bot.on('health', () => {
    state.health = Math.round(bot.health ?? 0);
    state.food   = Math.round(bot.food   ?? 0);
  });

  bot.once('spawn', () => {
    state.status = 'online';
    state.connects++;
    clearInterval(state.uptimeTimer);
    state.uptime = 0;
    state.uptimeTimer = setInterval(() => { state.uptime++; }, 1000);
    const pos = bot.entity?.position;
    state.pos    = pos ? `${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}` : '--';
    state.health = Math.round(bot.health ?? 20);
    state.food   = Math.round(bot.food   ?? 20);
    blog(state, `Spawned at (${state.pos})`);
    bot.chat('/register random123');
    bot.chat('/server Survival');
  });

  const posTimer = setInterval(() => {
    if (state.status !== 'online') return;
    const pos = bot.entity?.position;
    if (pos) state.pos = `${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`;
  }, 3000);

  bot.on('chat', (user, msg) => {
    if (user !== bot.username) blog(state, `<${user}> ${msg}`);
  });

  function onDisconnect(reason) {
    clearInterval(entityTimer);
    clearInterval(pingTimer);
    clearInterval(posTimer);
    clearInterval(state.uptimeTimer);
    state.bot    = null;
    state.status = 'reconnecting';
    state.health = '--';
    state.food   = '--';
    state.ping   = '--';
    if (reason) blog(state, `Disconnected: ${reason}`);
    blog(state, `Reconnecting in ${RECONNECT_DELAY / 1000}s...`);
    setTimeout(() => connectBot(username), RECONNECT_DELAY);
  }

  bot.on('kicked', (r) => { blog(state, `Kicked: ${r}`);        onDisconnect(r); });
  bot.on('error',  (e) => { blog(state, `Error: ${e.message}`); onDisconnect(''); });
  bot.on('end',    ()  => onDisconnect(''));
}

// ── Start ─────────────────────────────────────────────────────────────────────
const usernames = resolveUsernames();
flog(`Starting ${usernames.length} bot(s): ${usernames.join(', ')}`);
flog(`Logs -> ${LOG_FILE}`);

render();
usernames.forEach((name, i) => setTimeout(() => connectBot(name), i * STAGGER_DELAY));
