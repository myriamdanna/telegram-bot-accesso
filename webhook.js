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
      const telegramId = event.data.object.client_reference_id;

      // NOTIFICA ADMIN
      await bot.sendMessage(
        ADMIN_ID,
        `✅ Nuovo abbonamento!\nUtente Telegram ID: ${telegramId}`
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
      event.type === "invoice.payment_failed" ||
      event.type === "customer.subscription.deleted"
    ) {
      let telegramId = 
        Number(event.data.object.client_reference_id) ||
        Number(event.data.object.metadata?.telegramId);

      //NOTIFICA ADMIN
      await bot.sendMessage(
        ADMIN_ID,
        `❌ Abbonamento terminato!/nUtente: ${telegramId}`
      );

      try { 
        // fallback: recupero da customer Stripe
        if (!telegramId && event.data.object.customer) { 
          const customer = await stripe.customers.retrieve(
            event.data.object.customer
          );

          telegramId = Number(customer.metadata?.telegramId);
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
