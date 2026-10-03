// ============================================================
// MYRIAMBOT - WEBHOOK STRIPE
// INTERVENTO 03/10/2026:
// - verifica la firma degli eventi ricevuti da Stripe
// - distingue i pagamenti una tantum dei video dagli abbonamenti
// - dopo il pagamento verificato invia il video in chat privata
//   con protezione Telegram contro salvataggio e inoltro dall'app
// - lascia invariati rinnovi, avvisi e accesso al canale in abbonamento
// ============================================================

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const https = require("https");

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: false
});

const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_ID = 1192463575;

// Evita notifiche duplicate quando Stripe riconsegna lo stesso evento
// o invia piu volte lo stesso tentativo sulla medesima fattura.
// La memoria e limitata nel tempo per non crescere indefinitamente.
const EVENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const processedEventIds = new Map();
const processingEventIds = new Set();
const processingVideoSessionIds = new Set();
const notifiedFailureAttempts = new Map();

// Questo checkout ha gia ricevuto il video mentre Stripe ha registrato
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
      customerTitle: "Il rinnovo del tuo abbonamento non ÃÂ¨ andato a buon fine.",
      label: "rinnovo mensile",
    };
  }

  if (billingReason === "subscription_create") {
    return {
      adminTitle: "Primo pagamento abbonamento fallito!",
      customerTitle: "Il primo pagamento del tuo abbonamento non ÃÂ¨ andato a buon fine.",
      label: "primo pagamento",
    };
  }

  if (billingReason === "subscription_update") {
    return {
      adminTitle: "Pagamento modifica abbonamento fallito!",
      customerTitle: "Un pagamento relativo alla modifica del tuo abbonamento non ÃÂ¨ andato a buon fine.",
      label: "modifica abbonamento",
    };
  }

  return {
    adminTitle: "Pagamento fattura fallito!",
    customerTitle: "Un pagamento relativo al tuo abbonamento non ÃÂ¨ andato a buon fine.",
    label: billingReason || "fattura",
  };
}

function failureGuidance(declineCode) {
  const guidance = {
    insufficient_funds: {
      cause: "fondi o plafond insufficienti",
      action: "Verificare la disponibilitÃÂ  sulla carta oppure usare un altro metodo di pagamento.",
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
    console.log(`Video gia consegnato: retry Stripe confermato senza reinvio (${event.id})`);
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

      // Video acquistato: verifica lo stato effettivo interrogando Stripe,
      // poi invia in chat privata con protezione Telegram attiva.
      if (session.mode === "payment" && session.metadata?.purchase_type === "paid_telegram_video") {
        const videoSessionId = session.id;

        if (processingVideoSessionIds.has(videoSessionId)) {
          console.log(`Consegna gia in corso per ${videoSessionId}; evento confermato`);
          return res.sendStatus(200);
        }

        processingVideoSessionIds.add(videoSessionId);
        try {
          session = await stripe.checkout.sessions.retrieve(videoSessionId);

          if (session.metadata?.video_delivery_status === "delivered") {
            console.log(`Video gia consegnato per la sessione ${session.id}`);
          } else if (session.status !== "complete" || session.payment_status !== "paid") {
            console.log(`Pagamento video non ancora saldato: ${session.id}`);
          } else {
            const telegramId = session.client_reference_id || session.metadata?.telegramId;
            const productId = session.metadata?.videoProductId;

            if (!telegramId || !productId) {
              throw new Error(`Dati Telegram/prodotto mancanti nella sessione video ${session.id}`);
            }

            const product = await stripe.products.retrieve(productId);
            const fileId = product.metadata?.telegram_file_id;

            if (product.metadata?.myriambot_type !== "paid_telegram_video" || !fileId) {
              throw new Error(`Video non valido o file Telegram mancante per ${productId}`);
            }

            await bot.sendVideo(telegramId, fileId, {
              protect_content: true,
              caption: `Ã°ÂÂÂ¬ ${product.name}`,
            });

            // Memorizza l'esito su Stripe per bloccare i reinvii dopo retry o riavvio.
            await updateCheckoutSessionMetadata(session.id, {
              video_delivery_status: "delivered",
            });

            await bot.sendMessage(
              ADMIN_ID,
              `Ã¢ÂÂ Video consegnato dopo pagamento Stripe.\nTitolo: ${product.name}\nChat Telegram: ${telegramId}`
            );
          }
        } finally {
          processingVideoSessionIds.delete(videoSessionId);
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
        `Ã¢ÂÂ Nuovo abbonamento!\nUtente: ${displayName}`
      );

      //INVITO CANALE
      const invite = await bot.createChatInviteLink(CHANNEL_ID, {
        expire_date: Math.floor(Date.now() / 1000) + 60,
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
          "Ã¢ÂÂ Pagamento ricevuto! Entra nel canale:",
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
          `Ã°ÂÂÂ Abbonamento rinnovato!\nUtente: ${displayName}\nImporto: ${amount} Ã¢ÂÂ¬`
        );
      }
    }

    //PAGAMENTO RINNOVO FALLITO
    if (event.type === "invoice.payment_failed") {
      let invoice = event.data.object;

      // Recupera la versione piu aggiornata della fattura e il link sicuro
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
        console.log(`Tentativo di pagamento gia notificato: ${failureAttemptKey}`);
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
          `Ã¢ÂÂ Ã¯Â¸Â ${context.adminTitle}\n` +
          `Utente: ${displayName}\n` +
          `Operazione: ${context.label}\n` +
          `Tentativo: ${attemptNumber}\n` +
          `Causa: ${details.cause}${codeLine}\n` +
          `Prossimo tentativo: ${nextAttempt}\n` +
          `Cosa fare: ${details.action}\n` +
          `Il cliente non ÃÂ¨ stato rimosso dal canale.`
        );

        if (telegramId) {
          const paymentLink = invoice.hosted_invoice_url
            ? `\n\nPuoi regolarizzare il pagamento in sicurezza qui:\n${invoice.hosted_invoice_url}`
            : "";

          try {
            await bot.sendMessage(
              telegramId,
              `Ã¢ÂÂ Ã¯Â¸Â ${context.customerTitle}\n\n` +
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

      //NOTIFICA ADMIN
      await bot.sendMessage(
        ADMIN_ID,
        `Ã¢ÂÂ Abbonamento terminato!\nUtente: ${displayName}`
      );

      //RIMOZIONE DAL CANALE
      if (telegramId) { 
        await bot.banChatMember(CHANNEL_ID, telegramId);
        await bot.unbanChatMember(CHANNEL_ID, telegramId);

        console.log(`Utente ${telegramId} rimosso dal canale`);
      } else {
        console.log("Ã¢ÂÂ telegramId NON trovato");     
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
