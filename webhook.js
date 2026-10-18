// ============================================================
// MYRIAMBOT - WEBHOOK STRIPE
// INTERVENTO 03/10/2026:
// - verifica la firma degli eventi ricevuti da Stripe
// - distingue i pagamenti una tantum di video e foto dagli abbonamenti
// - dopo il pagamento verificato consegna video o pacchetti da 1 a 10 foto
//   in chat privata protetta
// - lascia invariati rinnovi, avvisi e accesso al canale in abbonamento
// ============================================================

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const https = require("https");
const crypto = require("crypto");

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const CHECKOUT_MINI_APP_URL = (process.env.CHECKOUT_MINI_APP_URL || "https://stripe-webhook-udt3.onrender.com/miniapp").replace(/\/+$/, "");
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";
const SUBSCRIPTION_PRICE_ID = process.env.STRIPE_SUBSCRIPTION_PRICE_ID || "price_1TG1UPKSYfmjXmRwCcfunIZp";
const checkoutRequests = new Map();

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: false
});

const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_ID = 1192463575;

function validateTelegramInitData(initData) {
  if (typeof initData !== "string" || !initData) {
    throw new Error("Dati Telegram mancanti");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  const authDate = Number(params.get("auth_date"));
  if (!/^[a-f0-9]{64}$/i.test(receivedHash)) throw new Error("Firma Telegram non valida");
  if (!Number.isFinite(authDate) || authDate > Math.floor(Date.now() / 1000) + 60 || Date.now() / 1000 - authDate > 600) {
    throw new Error("Sessione Telegram scaduta; riapri il modulo dal bot");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const expected = Buffer.from(calculatedHash, "hex");
  const actual = Buffer.from(receivedHash, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error("Firma Telegram non valida");
  }

  let user;
  try {
    user = JSON.parse(params.get("user") || "{}");
  } catch {
    throw new Error("Profilo Telegram non valido");
  }
  if (!user.id) throw new Error("Profilo Telegram non disponibile");
  return user;
}

app.get("/miniapp/config", (_req, res) => {
  if (!STRIPE_PUBLISHABLE_KEY) return res.status(503).json({ error: "Pagamento non configurato" });
  res.set("Cache-Control", "no-store").json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

app.get("/miniapp", (_req, res) => {
  res.set("Cache-Control", "no-store").type("html").send(`<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="color-scheme" content="light"><title>Abbonamento Myriamchannel</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script><script src="https://js.stripe.com/v3/"></script>
<style>body{margin:0;background:#f5f7fb;color:#172033;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:560px;margin:0 auto;padding:18px 14px}.card{background:#fff;border-radius:16px;padding:18px;box-shadow:0 3px 18px #15213a12}h1{font-size:21px;margin:0 0 8px}p{line-height:1.45;color:#46536a}#status{text-align:center;padding:24px 8px;color:#46536a}.error{color:#a32626}</style></head>
<body><main class="wrap"><section class="card"><h1>Abbonamento Myriamchannel</h1><p>Completa il pagamento in sicurezza con Stripe.</p><div id="status">Sto aprendo il modulo di pagamentoâ¦</div><div id="checkout"></div></section></main>
<script>
(async()=>{
 const tg=window.Telegram?.WebApp; const status=document.getElementById('status');
 if(!tg?.initData){status.className='error';status.textContent='Apri questo modulo dal pulsante nel bot Myriambot.';return;}
 tg.ready(); tg.expand();
 try{
   const config=await fetch('/miniapp/config',{cache:'no-store'}).then(r=>r.json());
   if(!config.publishableKey) throw new Error(config.error||'Configurazione Stripe mancante.');
   const created=await fetch('/api/subscription-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:tg.initData})});
   const payload=await created.json(); if(!created.ok) throw new Error(payload.error||'Non riesco a preparare il pagamento.');
   const stripe=Stripe(config.publishableKey);
   const checkout=await stripe.initEmbeddedCheckout({clientSecret:payload.clientSecret});
   status.remove(); checkout.mount('#checkout');
 }catch(error){status.className='error';status.textContent=error.message||'Errore durante lâapertura del pagamento. Riprova dal bot.';}
})();
</script></body></html>`);
});

app.get("/checkout/return", (_req, res) => {
  res.set("Cache-Control", "no-store").type("html").send(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://telegram.org/js/telegram-web-app.js"></script><title>Pagamento completato</title><style>body{font:17px -apple-system,BlinkMacSystemFont,sans-serif;padding:28px;color:#172033;text-align:center}button{border:0;border-radius:12px;padding:14px 22px;background:#2481cc;color:white;font-size:16px}</style></head><body><h2>Pagamento completato</h2><p>Myriambot ti invierÃ  in chat il link personale per entrare nel canale.</p><button onclick="window.Telegram?.WebApp?.close()">Torna a Telegram</button></body></html>`);
});

app.post("/api/subscription-checkout", express.json({ limit: "8kb" }), async (req, res) => {
  if (!STRIPE_PUBLISHABLE_KEY || !process.env.STRIPE_SECRET_KEY || !process.env.BOT_TOKEN) {
    return res.status(503).json({ error: "Pagamento temporaneamente non disponibile." });
  }

  try {
    const user = validateTelegramInitData(req.body?.initData);
    const userId = String(user.id);
    const previousRequest = checkoutRequests.get(userId) || 0;
    if (Date.now() - previousRequest < 15000) {
      return res.status(429).json({ error: "Checkout giÃ  in preparazione. Attendi qualche secondo." });
    }
    checkoutRequests.set(userId, Date.now());

    const firstName = user.first_name || "";
    const lastName = user.last_name || "";
    const username = user.username || "";
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    const returnUrl = new URL("/checkout/return?session_id={CHECKOUT_SESSION_ID}", CHECKOUT_MINI_APP_URL).toString();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      ui_mode: "embedded",
      redirect_on_completion: "if_required",
      return_url: returnUrl,
      client_reference_id: userId,
      metadata: { telegramId: userId, username, firstName, lastName, fullName },
      subscription_data: { metadata: { telegramId: userId, username, firstName, lastName, fullName } },
      line_items: [{ price: SUBSCRIPTION_PRICE_ID, quantity: 1 }],
    });

    if (!session.client_secret) throw new Error("Stripe non ha restituito il client secret del checkout embedded");
    return res.json({ clientSecret: session.client_secret });
  } catch (error) {
    console.error("â Errore creazione checkout embedded:", error.message);
    const status = /firma|telegram|profilo|scaduta/i.test(error.message) ? 401 : 500;
    return res.status(status).json({ error: status === 401 ? error.message : "Non riesco a preparare il pagamento. Riprova tra poco." });
  }
});

// Evita notifiche duplicate quando Stripe riconsegna lo stesso evento
// o invia piÃ¹ volte lo stesso tentativo sulla medesima fattura.
// La memoria e limitata nel tempo per non crescere indefinitamente.
const EVENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const processedEventIds = new Map();
const processingEventIds = new Set();
const processingPaidMediaSessionIds = new Set();
const notifiedFailureAttempts = new Map();

// Questo checkout ha giÃ  ricevuto il video mentre Stripe ha registrato
// un errore successivo nel webhook. Il retry dello stesso evento va solo
// confermato, senza inviare di nuovo il video.
const VIDEO_ALREADY_DELIVERED_EVENT_IDS = new Set([
  "evt_1UMW9JKSYfmjXmRwouo6OyLg",
]);

// Stripe Node SDK configurato nel servizio non espone sessions.update.
// Aggiorniamo i metadata usando l'endpoint REST ufficiale di Stripe.
function updateCheckoutSessionMetadata(sessionId, metadata) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(metadata)) {
    form.append(`metadata[${key}]`, String(value));
  }
  const body = form.toString();

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "api.stripe.com",
        path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { responseBody += chunk; });
        response.on("end", () => {
          let result;
          try {
            result = JSON.parse(responseBody);
          } catch {
            result = null;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(
              result?.error?.message || `Stripe API HTTP ${response.statusCode}`
            ));
            return;
          }
          resolve(result);
        });
      }
    );

    request.on("error", reject);
    request.end(body);
  });
}

function cleanupNotificationCaches() {
  const cutoff = Date.now() - EVENT_CACHE_TTL_MS;

  for (const [key, timestamp] of processedEventIds) {
    if (timestamp < cutoff) processedEventIds.delete(key);
  }

  for (const [key, timestamp] of notifiedFailureAttempts) {
    if (timestamp < cutoff) notifiedFailureAttempts.delete(key);
  }
}

function valueId(value) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id || null;
}

function formatStripeDate(timestamp) {
  if (!timestamp) return "non ancora programmato";

  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp * 1000));
}

function paymentContext(billingReason) {
  if (billingReason === "subscription_cycle") {
    return {
      adminTitle: "Pagamento rinnovo mensile fallito!",
      customerTitle: "Il rinnovo del tuo abbonamento non Ã¨ andato a buon fine.",
      label: "rinnovo mensile",
    };
  }

  if (billingReason === "subscription_create") {
    return {
      adminTitle: "Primo pagamento abbonamento fallito!",
      customerTitle: "Il primo pagamento del tuo abbonamento non Ã¨ andato a buon fine.",
      label: "primo pagamento",
    };
  }

  if (billingReason === "subscription_update") {
    return {
      adminTitle: "Pagamento modifica abbonamento fallito!",
      customerTitle: "Un pagamento relativo alla modifica del tuo abbonamento non Ã¨ andato a buon fine.",
      label: "modifica abbonamento",
    };
  }

  return {
    adminTitle: "Pagamento fattura fallito!",
    customerTitle: "Un pagamento relativo al tuo abbonamento non Ã¨ andato a buon fine.",
    label: billingReason || "fattura",
  };
}

function failureGuidance(declineCode) {
  const guidance = {
    insufficient_funds: {
      cause: "fondi o plafond insufficienti",
      action: "Verificare la disponibilitÃ  sulla carta oppure usare un altro metodo di pagamento.",
    },
    transaction_not_allowed: {
      cause: "transazione non autorizzata dalla banca",
      action: "Contattare la banca oppure usare un'altra carta. Il solo tentativo automatico potrebbe non riuscire.",
    },
    authentication_required: {
      cause: "autenticazione della carta richiesta",
      action: "Aprire la pagina Stripe e completare l'autenticazione oppure aggiornare il metodo di pagamento.",
    },
    expired_card: {
      cause: "carta scaduta",
      action: "Aggiornare il metodo di pagamento con una carta valida.",
    },
    card_not_supported: {
      cause: "carta non abilitata per questo tipo di pagamento",
      action: "Contattare la banca oppure usare un'altra carta.",
    },
    do_not_honor: {
      cause: "pagamento rifiutato dalla banca",
      action: "Contattare la banca oppure usare un altro metodo di pagamento.",
    },
    generic_decline: {
      cause: "pagamento rifiutato dalla banca",
      action: "Contattare la banca oppure usare un altro metodo di pagamento.",
    },
  };

  return guidance[declineCode] || {
    cause: "pagamento rifiutato",
    action: "Aprire la pagina Stripe, verificare il metodo di pagamento e, se necessario, contattare la banca.",
  };
}

async function paymentFailureDetails(invoice) {
  let paymentIntent =
    invoice.payment_intent ||
    invoice.payments?.data?.[0]?.payment?.payment_intent ||
    null;

  try {
    const paymentIntentId = valueId(paymentIntent);
    if (paymentIntentId) {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge"],
      });
    }
  } catch (error) {
    console.log("Impossibile recuperare il PaymentIntent:", error.message);
  }

  const paymentError =
    paymentIntent?.last_payment_error ||
    invoice.last_payment_error ||
    null;

  const latestCharge = paymentIntent?.latest_charge || null;
  const declineCode =
    paymentError?.decline_code ||
    latestCharge?.outcome?.reason ||
    "";

  const errorCode =
    paymentError?.code ||
    latestCharge?.failure_code ||
    "";

  const networkCode =
    paymentError?.network_decline_code ||
    latestCharge?.outcome?.network_decline_code ||
    "";

  return {
    declineCode,
    errorCode,
    networkCode,
    ...failureGuidance(declineCode),
  };
}

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET non configurato: webhook rifiutato per sicurezza.");
    return res.sendStatus(500);
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error("Firma webhook Stripe non valida:", error.message);
    return res.sendStatus(400);
  }

  console.log("EVENT RICEVUTO:", event.type);

  cleanupNotificationCaches();

  if (event.id && VIDEO_ALREADY_DELIVERED_EVENT_IDS.has(event.id)) {
    console.log(`Video giÃ  consegnato: retry Stripe confermato senza reinvio (${event.id})`);
    processedEventIds.set(event.id, Date.now());
    return res.sendStatus(200);
  }

  if (
    event.id &&
    (processedEventIds.has(event.id) || processingEventIds.has(event.id))
  ) {
    console.log(`Evento duplicato ignorato: ${event.id}`);
    return res.sendStatus(200);
  }

  if (event.id) processingEventIds.add(event.id);

  try {
    //PAGAMENTO COMPLETATO (abbonamento esistente o video una tantum)
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      let session = event.data.object;

      // Video o foto acquistati: verifica il pagamento su Stripe e consegna
      // il file corretto in chat privata con protezione Telegram attiva.
      const purchaseType = session.metadata?.purchase_type;
      if (
        session.mode === "payment" &&
        ["paid_telegram_video", "paid_telegram_photo"].includes(purchaseType)
      ) {
        const mediaSessionId = session.id;
        const mediaLabel = purchaseType === "paid_telegram_photo" ? "foto" : "video";
        const deliveryStatusKey = `${mediaLabel}_delivery_status`;
        const productIdKey = `${mediaLabel}ProductId`;

        if (processingPaidMediaSessionIds.has(mediaSessionId)) {
          console.log(`Consegna ${mediaLabel} giÃ  in corso per ${mediaSessionId}; evento confermato`);
          return res.sendStatus(200);
        }

        processingPaidMediaSessionIds.add(mediaSessionId);
        try {
          session = await stripe.checkout.sessions.retrieve(mediaSessionId);

          if (session.metadata?.[deliveryStatusKey] === "delivered") {
            console.log(`${mediaLabel} giÃ  consegnata per la sessione ${session.id}`);
          } else if (session.status !== "complete" || session.payment_status !== "paid") {
            console.log(`Pagamento ${mediaLabel} non ancora saldato: ${session.id}`);
          } else {
            const telegramId = session.client_reference_id || session.metadata?.telegramId;
            const productId = session.metadata?.[productIdKey];

            if (!telegramId || !productId) {
              throw new Error(`Dati Telegram/prodotto mancanti nella sessione ${mediaLabel} ${session.id}`);
            }

            const product = await stripe.products.retrieve(productId);

            if (product.metadata?.myriambot_type !== purchaseType) {
              throw new Error(`${mediaLabel} non valida per ${productId}`);
            }

            if (purchaseType === "paid_telegram_photo") {
              const photoCount = Number.parseInt(product.metadata?.photo_count || "0", 10);
              if (!Number.isInteger(photoCount) || photoCount < 1 || photoCount > 10) {
                throw new Error(`Numero di foto non valido per ${productId}`);
              }

              const photoFileIds = Array.from({ length: photoCount }, (_, index) =>
                product.metadata?.[`photo_file_id_${index + 1}`]
              );
              if (photoFileIds.some((fileId) => !fileId)) {
                throw new Error(`File Telegram mancanti per il pacchetto foto ${productId}`);
              }

              if (photoFileIds.length === 1) {
                await bot.sendPhoto(telegramId, photoFileIds[0], {
                  protect_content: true,
                  caption: `ð¸ ${product.name}`,
                });
              } else {
                const media = photoFileIds.map((fileId, index) => ({
                  type: "photo",
                  media: fileId,
                  ...(index === 0 ? { caption: `ð¸ ${product.name}` } : {}),
                }));
                await bot.sendMediaGroup(telegramId, media, { protect_content: true });
              }
            } else {
              const fileId = product.metadata?.telegram_file_id;
              if (!fileId) throw new Error(`File Telegram video mancante per ${productId}`);
              await bot.sendVideo(telegramId, fileId, {
                protect_content: true,
                caption: `ð¬ ${product.name}`,
              });
            }

            // Memorizza l'esito su Stripe per bloccare i reinvii dopo retry o riavvio.
            await updateCheckoutSessionMetadata(session.id, {
              [deliveryStatusKey]: "delivered",
            });

            await bot.sendMessage(
              ADMIN_ID,
              `â ${mediaLabel[0].toUpperCase()}${mediaLabel.slice(1)} consegnata dopo pagamento Stripe.\nTitolo: ${product.name}\nChat Telegram: ${telegramId}`
            );
          }
        } finally {
          processingPaidMediaSessionIds.delete(mediaSessionId);
        }
      } else if (event.type === "checkout.session.completed") {

      let telegramId =
        session.client_reference_id ||
        session.metadata?.telegramId ||
        null;

      let username = session.metadata?.username || "";
      let firstName = session.metadata?.firstName || "";
      let lastName = session.metadata?.lastName || "";
      let fullName = session.metadata?.fullName || "";

      // FALLBACK CUSTOMER STRIPE
      if ((!telegramId || !username || !fullName) && session.customer) {
        const customer = await stripe.customers.retrieve(session.customer);

        telegramId = telegramId || customer.metadata?.telegramId || null;
        username = username || customer.metadata?.username || "";
        firstName = firstName || customer.metadata?.firstName || "";
        lastName = lastName || customer.metadata?.lastName || "";
        fullName = fullName || customer.metadata?.fullName || `${firstName} ${lastName}`.trim();
      } 

      //NOME FINALE
      const displayName = 
          fullName && username 
          ? `${fullName} (@${username})`
          : fullName
          ? fullName
          : username
          ? `@${username}`
          : "Sconosciuto";
                        
      // NOTIFICA ADMIN
      await bot.sendMessage(
        ADMIN_ID,
        `â Nuovo abbonamento!\nUtente: ${displayName}`
      );

      //INVITO CANALE
      const invite = await bot.createChatInviteLink(CHANNEL_ID, {
        expire_date: Math.floor(Date.now() / 1000) + 180,
        member_limit: 1,
        creates_join_request: false,
        name: username 
          ? `user_${username}` 
          : `user_${telegramId}`,
      });

      const inviteLink = invite.invite_link;
      
      await new Promise(resolve => setTimeout(resolve, 1000));

      //INVIO LINK UTENTE
      if (telegramId) {
        await bot.sendMessage(
          telegramId,
          "â Pagamento ricevuto! Entra nel canale:",
          {
            reply_markup: {
              inline_keyboard: [[{ text: "Entra", url: inviteLink }]],
            },
          } 
        );
       }  
     }  

   //RINNOVO ABBONAMENTO PAGATO
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;

      if (invoice.billing_reason === "subscription_cycle") {
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const customer = await stripe.customers.retrieve(invoice.customer);

        let username =
          subscription.metadata?.username ||
          customer.metadata?.username ||
          "";

        let firstName =
          subscription.metadata?.firstName ||
          customer.metadata?.firstName ||
          "";

        let lastName =
          subscription.metadata?.lastName ||
          customer.metadata?.lastName ||
          "";

        let fullName =
          subscription.metadata?.fullName ||
          customer.metadata?.fullName ||
          `${firstName} ${lastName}`.trim();

        const displayName =
          fullName && username
            ? `${fullName} (@${username})`
            : fullName
            ? fullName
            : username
            ? `@${username}`
            : "Sconosciuto";

        const amount = (invoice.amount_paid / 100)
          .toFixed(2)
          .replace(".", ",");

        await bot.sendMessage(
          ADMIN_ID,
          `ð Abbonamento rinnovato!\nUtente: ${displayName}\nImporto: ${amount} â¬`
        );
      }
    }

    //PAGAMENTO RINNOVO FALLITO
    if (event.type === "invoice.payment_failed") {
      let invoice = event.data.object;

      // Recupera la versione piÃ¹ aggiornata della fattura e il link sicuro
      // ospitato da Stripe per pagare o aggiornare il metodo di pagamento.
      if (invoice.id) {
        try {
          invoice = await stripe.invoices.retrieve(invoice.id);
        } catch (error) {
          console.log("Impossibile aggiornare i dati della fattura:", error.message);
        }
      }

      const attemptNumber = invoice.attempt_count || 1;
      const failureAttemptKey = `${invoice.id || "invoice"}:${attemptNumber}`;
      const persistedFailureAttempt =
        invoice.metadata?.myriambot_failure_notification || "";

      if (
        notifiedFailureAttempts.has(failureAttemptKey) ||
        persistedFailureAttempt === failureAttemptKey
      ) {
        console.log(`Tentativo di pagamento giÃ  notificato: ${failureAttemptKey}`);
      } else {
        const context = paymentContext(invoice.billing_reason);

        const subscriptionId = valueId(
          invoice.subscription ||
          invoice.parent?.subscription_details?.subscription
        );
        const customerId = valueId(invoice.customer);

        const subscription = subscriptionId
          ? await stripe.subscriptions.retrieve(subscriptionId)
          : null;

        const customer = customerId
          ? await stripe.customers.retrieve(customerId)
          : null;

        const telegramId =
          subscription?.metadata?.telegramId ||
          customer?.metadata?.telegramId ||
          null;

        const username =
          subscription?.metadata?.username ||
          customer?.metadata?.username ||
          "";

        const firstName =
          subscription?.metadata?.firstName ||
          customer?.metadata?.firstName ||
          "";

        const lastName =
          subscription?.metadata?.lastName ||
          customer?.metadata?.lastName ||
          "";

        const fullName =
          subscription?.metadata?.fullName ||
          customer?.metadata?.fullName ||
          `${firstName} ${lastName}`.trim();

        const displayName =
          fullName && username
            ? `${fullName} (@${username})`
            : fullName
            ? fullName
            : username
            ? `@${username}`
            : "Sconosciuto";

        const details = await paymentFailureDetails(invoice);
        const nextAttempt = formatStripeDate(invoice.next_payment_attempt);
        const codeParts = [
          details.declineCode,
          details.networkCode ? `circuito ${details.networkCode}` : "",
        ].filter(Boolean);

        const codeLine = codeParts.length
          ? `\nCodice: ${codeParts.join(" - ")}`
          : "";

        await bot.sendMessage(
          ADMIN_ID,
          `â ï¸ ${context.adminTitle}\n` +
          `Utente: ${displayName}\n` +
          `Operazione: ${context.label}\n` +
          `Tentativo: ${attemptNumber}\n` +
          `Causa: ${details.cause}${codeLine}\n` +
          `Prossimo tentativo: ${nextAttempt}\n` +
          `Cosa fare: ${details.action}\n` +
          `Il cliente non Ã¨ stato rimosso dal canale.`
        );

        if (telegramId) {
          const paymentLink = invoice.hosted_invoice_url
            ? `\n\nPuoi regolarizzare il pagamento in sicurezza qui:\n${invoice.hosted_invoice_url}`
            : "";

          try {
            await bot.sendMessage(
              telegramId,
              `â ï¸ ${context.customerTitle}\n\n` +
              `Motivo: ${details.cause}.\n` +
              `${details.action}\n` +
              `Prossimo tentativo indicato da Stripe: ${nextAttempt}.` +
              paymentLink
            );
          } catch (error) {
            console.log(
              `Impossibile avvisare su Telegram l'utente ${telegramId}:`,
              error.message
            );
          }
        } else {
          console.log("Telegram ID non trovato: avviso cliente non inviato");
        }

        notifiedFailureAttempts.set(failureAttemptKey, Date.now());

        // Memorizza il tentativo anche su Stripe: in questo modo una
        // riconsegna successiva a un riavvio di Render non genera duplicati.
        if (invoice.id) {
          try {
            await stripe.invoices.update(invoice.id, {
              metadata: {
                myriambot_failure_notification: failureAttemptKey,
              },
            });
          } catch (error) {
            console.log(
              "Impossibile salvare su Stripe la chiave anti-duplicato:",
              error.message
            );
       }  
     }  
      }
    }
    }
    
    //ABBONAMENTO TERMINATO
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;

      let firstName = subscription.metadata?.firstName || "";
      let lastName = subscription.metadata?.lastName || "";
      let fullName = subscription.metadata?.fullName || "";
      let telegramId = subscription.metadata?.telegramId || null;
      let username = subscription.metadata?.username || "";
      
      //FALLBACK CUSTOMER STRIPE
      if (subscription.customer) {
        const customer = await stripe.customers.retrieve (
          subscription.customer
        );
        
        if (!telegramId) {
          telegramId = customer.metadata?.telegramId || null;
        }

        if (!username) {
          username = customer.metadata?.username || "";
        }

        if (!firstName) {
          firstName = customer.metadata?.firstName || "";
        } 

         if (!lastName) {
          lastName = customer.metadata?.lastName || "";
        } 

         if (!fullName) {
          fullName = customer.metadata?.fullName || 
          `${firstName} ${lastName}`.trim();
         } 
      }

      //NOME FINALE
      const displayName = 
          fullName && username 
          ? `${fullName} (@${username})`
          : fullName
          ? fullName
          : username
          ? `@${username}`
          : "Sconosciuto";

      const endedAt = subscription.ended_at || subscription.canceled_at || 0;
      const scheduledEnd = Boolean(
        subscription.cancel_at_period_end ||
        (subscription.cancel_at && endedAt && subscription.cancel_at <= endedAt)
      );
      const endedAfterBillingPeriod = Boolean(
        subscription.current_period_end &&
        endedAt >= subscription.current_period_end
      );
      const cancellationReason = subscription.cancellation_details?.reason || "";
      const isExpired =
        cancellationReason !== "payment_failed" &&
        (scheduledEnd || endedAfterBillingPeriod);

      // L'avviso di scadenza viene inviato solo alla fine del periodo pagato;
      // cancellazioni immediate e chiusure per mancato pagamento restano terminate.
      const endTitle = isExpired ? "â° Abbonamento scaduto!" : "â Abbonamento terminato!";

      //NOTIFICA ADMIN
      await bot.sendMessage(
        ADMIN_ID,
        `${endTitle}\nUtente: ${displayName}`
      );

      //RIMOZIONE DAL CANALE
      if (telegramId) { 
        await bot.banChatMember(CHANNEL_ID, telegramId);
        await bot.unbanChatMember(CHANNEL_ID, telegramId);

        console.log(`Utente ${telegramId} rimosso dal canale`);
      } else {
        console.log("â telegramId NON trovato");     
       } 
     }   
    
     if (event.id) processedEventIds.set(event.id, Date.now());
     res.sendStatus(200);
   } catch (err) {
     console.log(err);
     res.sendStatus(500);
   } finally {
     if (event.id) processingEventIds.delete(event.id);
   }
 });

    
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Webhook attivo"));
