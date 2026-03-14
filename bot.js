const mineflayer = require("mineflayer");

const CONFIG = {
  host: "Hot-Snow.play.hosting",
  port: 25565,
  username: "Misaki",
  version: "1.21.11",       // set your server version
  auth: "offline",          // use "microsoft" for online-mode servers
  reconnectDelay: 5000,     // ms between reconnect attempts
  maxReconnectDelay: 60000, // cap backoff at 60s
};

let bot = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

function getDelay() {
  // Exponential backoff: 5s → 10s → 20s → ... → 60s
  const delay = Math.min(
    CONFIG.reconnectDelay * Math.pow(2, reconnectAttempts),
    CONFIG.maxReconnectDelay
  );
  return delay;
}

function createBot() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  console.log(`[Bot] Connecting to ${CONFIG.host}:${CONFIG.port}...`);

  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: CONFIG.auth,
  });

  // ── Successful login ──────────────────────────────────────────────
  bot.once("login", () => {
    reconnectAttempts = 0; // reset backoff on success
    console.log(`[Bot] Logged in as ${bot.username}`);
  });

  bot.once("spawn", () => {
    console.log("[Bot] Spawned in world");
    // Put your normal bot logic here
  });

  // ── Chat listener (example) ───────────────────────────────────────
  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    console.log(`[Chat] <${username}> ${message}`);
  });

  // ── Keep-alive: anti-AFK movement every 4 minutes ─────────────────
  let afkTimer = null;

  bot.once("spawn", () => {
    afkTimer = setInterval(() => {
      if (!bot || !bot.entity) return;
      bot.setControlState("jump", true);
      setTimeout(() => bot && bot.setControlState("jump", false), 500);
    }, 4 * 60 * 1000);
  });

  // ── Error handling ─────────────────────────────────────────────────
  bot.on("error", (err) => {
    console.error(`[Bot] Error: ${err.message}`);
  });

  // ── Kicked from server ─────────────────────────────────────────────
  bot.on("kicked", (reason, loggedIn) => {
    let parsed = reason;
    try { parsed = JSON.parse(reason)?.text ?? reason; } catch {}
    console.warn(`[Bot] Kicked: ${parsed} (loggedIn=${loggedIn})`);
    cleanupAndReconnect();
  });

  // ── Connection dropped ─────────────────────────────────────────────
  bot.on("end", (reason) => {
    console.warn(`[Bot] Disconnected: ${reason}`);
    if (afkTimer) { clearInterval(afkTimer); afkTimer = null; }
    cleanupAndReconnect();
  });
}

function cleanupAndReconnect() {
  // Remove all listeners to avoid memory leaks on the old instance
  if (bot) {
    bot.removeAllListeners();
    bot = null;
  }

  const delay = getDelay();
  reconnectAttempts++;
  console.log(
    `[Bot] Reconnecting in ${delay / 1000}s... (attempt #${reconnectAttempts})`
  );

  reconnectTimer = setTimeout(createBot, delay);
}

// ── Graceful shutdown ────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\n[Bot] Shutting down...");
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (bot) bot.quit("Shutting down");
  process.exit(0);
});

// ── Start ────────────────────────────────────────────────────────────
createBot();
