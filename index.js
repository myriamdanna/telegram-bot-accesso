// ============================================================
// MYRIAMBOT - ACCESSO E PAGAMENTO STRIPE
// PATCH 21/09/2026:
// - riavvio automatico del servizio in caso di polling Telegram bloccato
// - watchdog periodico con controllo della connessione Telegram
// - notifica opzionale all'amministratore dopo avvio/ripristino
// - comando /chatid per recuperare in sicurezza il proprio Telegram Chat ID
// ============================================================

const utenti = new Set();
const TelegramBot = require("node-telegram-bot-api");
const Stripe = require("stripe");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_ID_5_EURO = "price_1TG1UPKSYfmjXmRwCcfunIZp";
const PRICE_ID_10_EURO = "price_1U8HRWKSYfmjXmRwxjE916lj";

// Inserire su Render una variabile ADMIN_CHAT_ID con il Chat ID di Myriam.
// Se non è configurata, il bot continua a funzionare e scrive gli avvisi nei log.
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";

const HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const HEALTH_CHECK_TIMEOUT_MS = 15 * 1000;
const MAX_CONSECUTIVE_HEALTH_FAILURES = 3;
const RESTART_DELAY_MS = 5000;

let consecutiveHealthFailures = 0;
let restartScheduled = false;
let shutdownInProgress = false;

// 1° settembre 2026, ore 00:00 in Italia
const CAMBIO_PREZZO = Date.UTC(2026, 7, 31, 22, 0, 0);


function errorDetails(error) {
  if (!error) return "errore sconosciuto";

  const parts = [
    error.code,
    error.message,
    error.response?.body?.description,
  ].filter(Boolean);

  return parts.join(" | ") || String(error);
}


function withTimeout(promise, timeoutMs, label) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label}: timeout dopo ${timeoutMs} ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}


async function notifyAdmin(message) {
  if (!ADMIN_CHAT_ID) {
    console.log("ℹ️ ADMIN_CHAT_ID non configurato: notifica Telegram non inviata.");
    return;
  }

  try {
    await withTimeout(
      bot.sendMessage(ADMIN_CHAT_ID, message),
      HEALTH_CHECK_TIMEOUT_MS,
      "notifica amministratore"
    );
  } catch (error) {
    console.error("❌ Impossibile notificare l'amministratore:", errorDetails(error));
  }
}


function scheduleServiceRestart(reason) {
  if (restartScheduled || shutdownInProgress) return;

  restartScheduled = true;
  console.error(`🚨 Riavvio automatico richiesto: ${reason}`);

  // Il messaggio potrebbe non partire se Telegram è irraggiungibile.
  // Dopo il riavvio verrà comunque inviato l'avviso di ritorno online.
  void notifyAdmin(
    `🚨 Myriambot ha rilevato un problema e si riavvierà automaticamente.\nMotivo: ${reason}`
  );

  setTimeout(() => {
    console.error("♻️ Chiusura controllata: Render riavvierà il worker.");
    process.exit(1);
  }, RESTART_DELAY_MS);
}


async function runTelegramHealthCheck() {
  if (restartScheduled || shutdownInProgress) return;

  try {
    if (typeof bot.isPolling === "function" && !bot.isPolling()) {
      scheduleServiceRestart("polling Telegram non attivo");
      return;
    }

    await withTimeout(
      bot.getMe(),
      HEALTH_CHECK_TIMEOUT_MS,
      "controllo Telegram getMe"
    );

    if (consecutiveHealthFailures > 0) {
      console.log("✅ Connessione Telegram ripristinata.");
    }

    consecutiveHealthFailures = 0;
  } catch (error) {
    consecutiveHealthFailures += 1;
    console.error(
      `⚠️ Health check Telegram fallito ${consecutiveHealthFailures}/${MAX_CONSECUTIVE_HEALTH_FAILURES}:`,
      errorDetails(error)
    );

    if (consecutiveHealthFailures >= MAX_CONSECUTIVE_HEALTH_FAILURES) {
      scheduleServiceRestart(
        `health check fallito ${consecutiveHealthFailures} volte: ${errorDetails(error)}`
      );
    }
  }
}


bot.on("polling_error", (error) => {
  // node-telegram-bot-api gestisce il ciclo di polling. Errori di rete
  // transitori (per esempio ECONNRESET) vengono registrati senza terminare
  // subito il processo: il controllo periodico riavvia Render solo se il
  // collegamento Telegram continua a non rispondere.
  console.error("⚠️ Errore temporaneo polling Telegram:", errorDetails(error));
});


bot.on("error", (error) => {
  console.error("❌ Errore generale Telegram:", errorDetails(error));
});


process.on("unhandledRejection", (reason) => {
  const details = errorDetails(reason);
  console.error("❌ Promise non gestita:", details);
  scheduleServiceRestart(`promise non gestita: ${details}`);
});


process.on("uncaughtException", (error) => {
  const details = errorDetails(error);
  console.error("❌ Eccezione non gestita:", details);
  scheduleServiceRestart(`eccezione non gestita: ${details}`);
});


async function gracefulShutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  console.log(`🛑 Ricevuto ${signal}: arresto ordinato del polling.`);

  try {
    await withTimeout(
      bot.stopPolling({ cancel: true }),
      HEALTH_CHECK_TIMEOUT_MS,
      "arresto polling"
    );
  } catch (error) {
    console.error("⚠️ Errore durante l'arresto del polling:", errorDetails(error));
  } finally {
    process.exit(0);
  }
}


process.once("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});


// Primo controllo poco dopo l'avvio e successivi controlli ogni due minuti.
setTimeout(async () => {
  await runTelegramHealthCheck();

  if (!restartScheduled && consecutiveHealthFailures === 0) {
    console.log("✅ Myriambot online: polling e API Telegram operativi.");
    await notifyAdmin(
      "✅ Myriambot è online. Polling e collegamento Telegram sono operativi."
    );
  }
}, 10000);

setInterval(() => {
  void runTelegramHealthCheck();
}, HEALTH_CHECK_INTERVAL_MS);


bot.on("message", async (msg) => {
  const text = msg.text?.trim().toLowerCase();
  const chatId = msg.chat.id;

  if (!text) return;

  // Permette a Myriam di recuperare il valore da inserire in ADMIN_CHAT_ID.
  if (text === "/chatid") {
    return bot.sendMessage(chatId, `Il tuo Telegram Chat ID è: ${chatId}`);
  }

  // Accetta "ciao" o /start.
  if (!text.includes("ciao") && text !== "/start") return;

  if (utenti.has(chatId)) return;
  utenti.add(chatId);

  setTimeout(() => {
    utenti.delete(chatId);
  }, 5000);

  try {
    const firstName = msg.from.first_name || '';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username || '';

    const fullName = [firstName, lastName]
      .filter(Boolean)
      .join(" ");
    
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
  
      client_reference_id: chatId.toString(),
 
      metadata: {
          telegramId: chatId.toString(),
          username: username,
          firstName: firstName,
          lastName: lastName,
          fullName: fullName
      },

      subscription_data: {
        metadata: {
          telegramId: chatId.toString(),
          username: username,
          firstName: firstName,
          lastName: lastName,
          fullName: fullName
        }
      },
        
      line_items: [
        {
          price: PRICE_ID_5_EURO,
          quantity: 1,
        },
      ],
      
      success_url: "https://t.me/Myriamchannelbot?start=success",
      cancel_url: "https://t.me/Myriamchannelbot?start=cancel",
    });

    return bot.sendMessage(
      chatId,
      "🔥 Accedi qui 👇\n" + session.url
    );

  } catch (error) {
    console.log("❌ ERRORE STRIPE COMPLETO:");
    console.log(error);
    console.log(error.message);
    console.log(error.raw);
    
    return bot.sendMessage(chatId, "❌ Errore pagamento, riprova");
  }
});
