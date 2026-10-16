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

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_ID_5_EURO = "price_1TG1UPKSYfmjXmRwCcfunIZp";
const PRICE_ID_10_EURO = "price_1U8HRWKSYfmjXmRwxjE916lj";

// Inserire su Render una variabile ADMIN_CHAT_ID con il Chat ID di Myriam.
// Se non è configurata, il bot continua a funzionare e scrive gli avvisi nei log.
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";
const BOT_USERNAME = "Myriamchannelbot";

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
    return sendMessageSafely(chatId, message);
  }

  // Accetta "ciao" o /start.
  if (!normalizedText.includes("ciao") && !startMatch) return;

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

    return sendMessageSafely(
      chatId,
      "🔥 Accedi qui 👇\n" + session.url
    );

  } catch (error) {
    console.log("❌ ERRORE STRIPE COMPLETO:");
    console.log(error);
    console.log(error.message);
    console.log(error.raw);
    
    return sendMessageSafely(chatId, "❌ Errore pagamento, riprova");
  }
});
