const express = require("express");
const bodyParser = require("body-parser");
const TelegramBot = require("node-telegram-bot-api");

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(bodyParser.json());

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_ID = 1192463575;

app.post("/webhook", async (req, res) => {
  const event = req.body;

  console.log("EVENT RICEVUTO:", event.type);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const telegramId = session.client_reference_id;

      const metadata = session.metadata;

      const username = metadata?.telegram_username;
      const name = metadata?.telegram_name;

      const display = username
        ? `@${username}`
        : name || telegramId;

      // QUESTO E' IL FIX
      if (session.subscription) {
        await stripe.subscriptions.update(session.subscription, {
          metadata: session.metadata
         });
      }
      
      // NOTIFICA ADMIN
      await bot.sendMessage(
        ADMIN_ID,
        `✅ Nuovo abbonamento!\nUtente: ${display}`
      );
      
      const invite = await bot.createChatInviteLink(CHANNEL_ID, {
        member_limit: 1,
        name: `user_${telegramId}`,
      });

      const inviteLink = invite.invite_link;
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await bot.sendMessage(
        telegramId,
        "✅ Pagamento ricevuto! Entra nel canale:",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "Entra", url: inviteLink }]],
          },
        } 
      );
    }

    if (
      event.type === "customer.subscription.deleted" ||
      event.type === "invoice.payment_failed"
    ) {
      let metadata = {};
      let telegramId

      //CASO 1: SUBSCRIPTION CANCELLATA
      if event.type === "customer.subscription.deleted"  ) {
        const subscription = event.data.object;

        metadata = subscription.metadata || {};
      
        // FIX: se metadata manca, recupera dal customer
        if (!metadata.telegram_id && subscription.customer) {
          const customer = await stripe.customers.retrieve(subscription.customer);
          metadata = customer.metadata || {};
        }
                
        telegramId = 
          Number(metadata.telegram_id) ||
          Number(event.data.object.client_reference_id);
      }

        // CASO 2: PAGAMENTO FALLITO
        if (event.type === "invoice.payment.failed") {
          const invoice = event.data.object;

          if (invoice.customer)  { 
            const customer = await stripe.customers.retrieve(invoice.customer);
            metadata = customer.metadata || {};
          }

          telegramId = Number(metadata.telegram_id);
        
        }
      
        //PRENDI USERNAME E NOME
        const username = metadata?.telegram_username;
        const name = metadata?.telegram_name;
    
        //COSTRUISCI DISPLAY
        const display = username
          ? `@${username}`
          : name || telegramId;
      
      //NOTIFICA ADMIN
      await bot.sendMessage(
        ADMIN_ID,
        `❌ Abbonamento terminato!\nUtente: ${display}`
      );
    } 

      try { 
        // fallback: recupero da customer Stripe
        if (!telegramId && event.data.object.customer) { 
          const customer = await stripe.customers.retrieve(
            event.data.object.customer
          );

          telegramId = Number(customer.metadata?.telegram_id) || telegramId;
         } 
      
         if (!telegramId) { 
           console.log("❌ telegramId NON trovato");
           return; 
         }
        
        await bot.banChatMember(CHANNEL_ID, telegramId);
        await bot.unbanChatMember(CHANNEL_ID, telegramId);

        console.log ('Utente ${telegramId} rimosso dal canale');
      } catch (err) {
        console.error("Errore rimozione utente:", err);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.log(err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Webhook attivo"));
