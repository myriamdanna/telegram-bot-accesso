// ============================================================
// MYRIAMBOT - ACCESSO E PAGAMENTO STRIPE
// INTERVENTO 03/10/2026:
// - mantenuto il prezzo di 5 € per i nuovi abbonamenti al canale
// - registrazione admin di video, foto singole e album con relativo prezzo Stripe
// - link personale al checkout Stripe tramite pulsante pubblicato nel canale
// - consegna privata protetta dopo conferma del pagamento, senza alterare gli abbonamenti
// PATCH 21/09/2026:
// - riavvio automatico del servizio in caso di polling Telegram bloccato
// - watchdog periodico con controllo della connessione Telegram
// - notifica opzionale all'amministratore dopo avvio/ripristino
// - comando /chatid per recuperare in sicurezza il proprio Telegram Chat ID
// ============================================================

const utenti = new Set();
const photoAlbumBuffers = new Map();
const TelegramBot = require("node-telegram-bot-api");
const Stripe = require("stripe");

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: { params: { allowed_updates: ["message", "callback_query", "chat_member"] } },
});
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_ID_5_EURO = "price_1TG1UPKSYfmjXmRwCcfunIZp";
const PRICE_ID_10_EURO = "price_1U8HRWKSYfmjXmRwxjE916lj";

// Inserire su Render una variabile ADMIN_CHAT_ID con il Chat ID di Myriam.
// Se non è configurata, il bot continua a funzionare e scrive gli avvisi nei log.
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";
const BOT_USERNAME = "Myriamchannelbot";
const CHECKOUT_MINI_APP_URL = process.env.CHECKOUT_MINI_APP_URL || "https://stripe-webhook-udt3.onrender.com/miniapp";

const HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const HEALTH_CHECK_TIMEOUT_MS = 15 * 1000;
const MAX_CONSECUTIVE_HEALTH_FAILURES = 3;
const RESTART_DELAY_MS = 5000;

let consecutiveHealthFailures = 0;
let restartScheduled = false;
let shutdownInProgress = false;
const accessRecoveryRequests = new Map();

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

// Un utente può bloccare il bot o revocare il consenso. Un 403 riguarda
// quella chat e non deve provocare il riavvio dell'intero servizio.
function sendMessageSafely(chatId, message, options) {
  return bot.sendMessage(chatId, message, options).catch((error) => {
    const statusCode = error?.response?.statusCode || error?.statusCode;
    if (statusCode === 403) {
      console.log(`Messaggio Telegram non inviato: chat ${chatId} ha bloccato il bot.`);
      return null;
    }
    throw error;
  });
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



async function registerPaidTelegramProduct({ chatId, mediaLabel, command, caption, fileIds }) {
  const match = String(caption || "").trim().match(
    new RegExp(`^\\/${command}\\s+(.+?)\\s*\\|\\s*(\\d+(?:[.,]\\d{1,2})?)\\s*€?$`, "i")
  );
  if (!match) {
    const example = mediaLabel === "foto"
      ? "Invia la foto o l'album con questa didascalia:\n/nuovafoto Titolo del pacchetto | 4,99"
      : "Per registrare il video, aggiungi questa didascalia:\n/nuovovideo Titolo del video | 4,99";
    return sendMessageSafely(chatId, example);
  }

  const title = match[1].trim();
  const amount = Number(match[2].replace(",", "."));
  const amountCents = Math.round(amount * 100);
  const cleanFileIds = [...new Set(fileIds || [])];

  if (!title || title.length > 120 || !Number.isFinite(amountCents) || amountCents < 50 || amountCents > 100000) {
    return sendMessageSafely(chatId, "Titolo o prezzo non valido. Il prezzo deve essere tra 0,50 € e 1.000,00 €.");
  }
  if (!cleanFileIds.length || (mediaLabel === "foto" && cleanFileIds.length > 10)) {
    return sendMessageSafely(chatId, "Numero di foto non valido: puoi registrare da 1 a 10 foto per prodotto.");
  }

  try {
    const metadata = {
      myriambot_type: mediaLabel === "foto" ? "paid_telegram_photo" : "paid_telegram_video",
    };
    if (mediaLabel === "foto") {
      metadata.photo_count = String(cleanFileIds.length);
      cleanFileIds.forEach((fileId, index) => {
        metadata[`photo_file_id_${index + 1}`] = fileId;
      });
    } else {
      metadata.telegram_file_id = cleanFileIds[0];
    }

    const product = await stripe.products.create({ name: title, active: true, metadata });
    const price = await stripe.prices.create({
      product: product.id,
      currency: "eur",
      unit_amount: amountCents,
    });
    await stripe.products.update(product.id, { default_price: price.id });

    const purchaseUrl = `https://t.me/${BOT_USERNAME}?start=buy_${product.id}`;
    const formattedAmount = (amountCents / 100).toFixed(2).replace(".", ",");
    const itemDescription = mediaLabel === "foto"
      ? `${cleanFileIds.length} ${cleanFileIds.length === 1 ? "foto" : "foto"}`
      : "video";

    return sendMessageSafely(
      chatId,
      `✅ ${mediaLabel === "foto" ? "Foto" : "Video"} ${mediaLabel === "foto" ? "registrate" : "registrato"} su Stripe.\n` +
      `Titolo: ${title}\nContenuto: ${itemDescription}\nPrezzo: ${formattedAmount} €\n\n` +
      `Nel post della preview su Myriamchannel, aggiungi un pulsante con questo link:\n${purchaseUrl}\n\n` +
      `Dopo il pagamento confermato, il cliente riceverà ${mediaLabel === "foto" ? "la foto o l'album" : "il video"} nella chat privata con Myriambot, con protezione Telegram attiva.`
    );
  } catch (error) {
    console.error(`❌ Errore registrazione ${mediaLabel}:`, error.message);
    return sendMessageSafely(chatId, `❌ Non sono riuscito a registrare ${mediaLabel === "foto" ? "le foto" : "il video"}. Riprova; il bot non ha pubblicato alcun link.`);
  }
}

async function recoverChannelAccess(userId, chatId) {
  const telegramId = String(userId);
  const now = Date.now();
  for (const [key, timestamp] of accessRecoveryRequests) {
    if (now - timestamp > 5 * 60 * 1000) accessRecoveryRequests.delete(key);
  }
  const lastRequestAt = accessRecoveryRequests.get(telegramId) || 0;
  if (now - lastRequestAt < 30000) {
    return sendMessageSafely(chatId, "Hai appena richiesto un link. Attendi 30 secondi prima di riprovare.");
  }
  accessRecoveryRequests.set(telegramId, Date.now());

  try {
    const result = await stripe.subscriptions.search({
      query: `status:'active' AND metadata['telegramId']:'${telegramId}'`,
      limit: 100,
    });
    const activeSubscription = result.data.find((subscription) =>
      subscription.status === "active" && String(subscription.metadata?.telegramId || "") === telegramId
    );

    if (!activeSubscription) {
      console.log(`Recupero accesso negato: nessun abbonamento attivo per Telegram ${telegramId}`);
      return sendMessageSafely(chatId, "Non trovo un abbonamento attivo collegato a questo account Telegram. Se hai pagato, contatta Myriam indicando l’email usata su Stripe.");
    }

    let member;
    try {
      member = await bot.getChatMember(CHANNEL_ID, userId);
    } catch (error) {
      console.warn(`Verifica appartenenza canale non riuscita per Telegram ${telegramId}:`, errorDetails(error));
    }
    if (["member", "administrator", "creator"].includes(member?.status)) {
      console.log(`Recupero accesso: Telegram ${telegramId} è già nel canale`);
      return sendMessageSafely(chatId, "Il tuo account risulta già iscritto al canale. Apri Telegram e controlla la chat Myriamchannel.");
    }
    if (member?.status === "kicked") {
      console.log(`Recupero accesso bloccato: Telegram ${telegramId} risulta rimosso dal canale`);
      return sendMessageSafely(chatId, "Non posso creare un link per questo account. Contatta Myriam per verificare l’accesso al canale.");
    }

    const invite = await bot.createChatInviteLink(CHANNEL_ID, {
      expire_date: Math.floor(Date.now() / 1000) + 600,
      member_limit: 1,
      creates_join_request: false,
      name: `recovery_${telegramId}`,
    });
    console.log(`Link di recupero creato per Telegram ${telegramId}; subscription ${activeSubscription.id}; scadenza 180s`);

    await sendMessageSafely(chatId, "✅ Abbonamento attivo verificato. Usa subito questo pulsante per entrare nel canale:", {
      reply_markup: { inline_keyboard: [[{ text: "Entra in Myriamchannel", url: invite.invite_link }]] },
    });
    console.log(`Link di recupero inviato a Telegram ${telegramId}`);
  } catch (error) {
    console.error(`Errore recupero accesso per Telegram ${telegramId}:`, errorDetails(error));
    return sendMessageSafely(chatId, "Non riesco a verificare o ripristinare l’accesso in questo momento. Riprova tra poco o contatta Myriam.");
  }
}

bot.on("callback_query", async (query) => {
  if (query.data !== "recover_channel_access") return;
  const chatId = query.message?.chat?.id;
  const userId = query.from?.id;
  await bot.answerCallbackQuery(query.id);
  if (!chatId || !userId) return;
  await recoverChannelAccess(userId, chatId);
});

bot.on("chat_member", (update) => {
  if (String(update.chat?.id) !== String(CHANNEL_ID)) return;
  const user = update.new_chat_member?.user;
  const oldStatus = update.old_chat_member?.status;
  const newStatus = update.new_chat_member?.status;
  if (!user || oldStatus === newStatus) return;
  console.log(`AGGIORNAMENTO ACCESSO CANALE: Telegram ${user.id}; ${oldStatus} -> ${newStatus}; invite ${update.invite_link?.name || "non disponibile"}`);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const rawText = msg.text || msg.caption || "";
  const text = rawText.trim();
  const normalizedText = text.toLowerCase();

  // Solo Myriam può registrare video e foto a pagamento.
  // Foto singola: inviare la foto con didascalia /nuovafoto Titolo | 4,99.
  // Album: inviare le foto insieme e inserire la stessa didascalia sull'album.
  if (msg.video || msg.photo?.length) {
    if (!ADMIN_CHAT_ID || String(chatId) !== String(ADMIN_CHAT_ID)) {
      console.log(`Upload media a pagamento rifiutato da chat non amministratore: ${chatId}`);
      return;
    }

    if (msg.video) {
      return registerPaidTelegramProduct({
        chatId,
        mediaLabel: "video",
        command: "nuovovideo",
        caption: text,
        fileIds: [msg.video.file_id],
      });
    }

    const fileId = msg.photo[msg.photo.length - 1].file_id;
    if (!msg.media_group_id) {
      return registerPaidTelegramProduct({
        chatId,
        mediaLabel: "foto",
        command: "nuovafoto",
        caption: text,
        fileIds: [fileId],
      });
    }

    // Telegram invia ogni elemento dell'album come messaggio separato.
    // Li raccogliamo per media_group_id e registriamo il prodotto quando
    // smettono di arrivare aggiornamenti per questo album.
    const albumKey = `${chatId}:${msg.media_group_id}`;
    let album = photoAlbumBuffers.get(albumKey);
    if (!album) {
      album = { chatId, caption: "", fileIds: [], timer: null };
      photoAlbumBuffers.set(albumKey, album);
    }

    if (!album.fileIds.includes(fileId)) album.fileIds.push(fileId);
    if (text.startsWith("/nuovafoto") && !album.caption) album.caption = text;
    if (album.timer) clearTimeout(album.timer);

    album.timer = setTimeout(() => {
      photoAlbumBuffers.delete(albumKey);
      void registerPaidTelegramProduct({
        chatId: album.chatId,
        mediaLabel: "foto",
        command: "nuovafoto",
        caption: album.caption,
        fileIds: album.fileIds,
      });
    }, 1800);

    return;
  }
  if (!text) return;

  // Permette a Myriam di recuperare il valore da inserire in ADMIN_CHAT_ID.
  if (normalizedText === "/chatid") {
    return sendMessageSafely(chatId, `Il tuo Telegram Chat ID è: ${chatId}`);
  }

  // Il pulsante sul canale apre un link personale al bot: il payload identifica il prodotto.
  const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]+))?$/i);
  const startPayload = startMatch?.[1] || "";
  if (startPayload.startsWith("buy_prod_")) {
    const productId = startPayload.slice(4);

    try {
      const product = await stripe.products.retrieve(productId);
      const mediaType = product.metadata?.myriambot_type;
      if (!product.active || !["paid_telegram_video", "paid_telegram_photo"].includes(mediaType)) {
        return sendMessageSafely(chatId, "Questo contenuto non è al momento disponibile per l'acquisto.");
      }
      const mediaLabel = mediaType === "paid_telegram_photo" ? "foto" : "video";

      const priceId = typeof product.default_price === "string"
        ? product.default_price
        : product.default_price?.id;
      if (!priceId) throw new Error(`Il prodotto ${mediaLabel} non ha un prezzo predefinito.`);

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        client_reference_id: String(chatId),
        metadata: {
          purchase_type: mediaType,
          telegramId: String(chatId),
          [`${mediaLabel}ProductId`]: product.id,
          username: msg.from.username || "",
          firstName: msg.from.first_name || "",
          lastName: msg.from.last_name || "",
        },
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `https://t.me/${BOT_USERNAME}?start=${mediaLabel}_paid`,
        cancel_url: `https://t.me/${BOT_USERNAME}?start=${mediaLabel}_cancelled`,
      });

      return sendMessageSafely(
        chatId,
        `${mediaLabel === "foto" ? "📸" : "🎬"} Acquisto: ${product.name}\nCompleta il pagamento sicuro su Stripe:\n${session.url}`
      );
    } catch (error) {
      console.error(`❌ Errore creazione checkout ${mediaLabel}:`, error.message);
      return sendMessageSafely(chatId, `❌ Non riesco ad aprire il pagamento per questo contenuto. Avvisa Myriam e riprova più tardi.`);
    }
  }

  if (/^\/accesso(?:@\w+)?$/i.test(text) || normalizedText === "non riesco a entrare") {
    return recoverChannelAccess(msg.from?.id || chatId, chatId);
  }

  // I link di ritorno da Stripe non devono avviare un nuovo abbonamento.
  if (["video_paid", "video_cancelled", "photo_paid", "photo_cancelled", "success", "cancel"].includes(startPayload)) {
    let message;
    if (startPayload === "video_paid") {
      message = "✅ Grazie! Stripe sta confermando il pagamento. Riceverai qui il video appena la conferma sarà completata.";
    } else if (startPayload === "photo_paid") {
      message = "✅ Grazie! Stripe sta confermando il pagamento. Riceverai qui la foto appena la conferma sarà completata.";
    } else if (startPayload === "success") {
      message = "✅ Pagamento completato! Stripe sta confermando l'abbonamento. Se hai già ricevuto il link d'accesso, puoi entrare nel canale.";
    } else {
      message = "Pagamento non completato. Se vuoi, puoi tornare alla locandina e riprovare.";
    }
    return sendMessageSafely(
      chatId,
      message,
      startPayload === "success"
        ? { reply_markup: { inline_keyboard: [[{ text: "🔄 Non riesco a entrare", callback_data: "recover_channel_access" }]] } }
        : undefined
    );
  }

  // Saluto o /start: un solo tocco apre il modulo Stripe incorporato in Telegram.
  if (!normalizedText.includes("ciao") && !startMatch) return;

  return sendMessageSafely(
    chatId,
    "👋 Ciao! Per iscriverti a Myriamchannel, premi il pulsante qui sotto: si aprirà subito il modulo di pagamento Stripe.",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "💳 Voglio abbonarmi", web_app: { url: CHECKOUT_MINI_APP_URL } }]],
      },
    }
  );
});
