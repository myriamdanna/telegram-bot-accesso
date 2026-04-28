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

      let telegramId =
        Number(session.client_reference_id) ||
        Number(session.metadata?.telegramId) ||
        null;

      let username = session.metadata?.username || "";

      if ((!telegramId || !username) && session.customer) {
        const customer = await stripe.customers.retrieve(session.customer);

        if (!telegramId) {
          telegramId = Number(customer.metadata?.telegramId);
        }

         if (!username) {
          username = customer.metadata?.username;
         }
        } 
        
      // NOTIFICA ADMIN
      await bot.sendMessage(
        ADMIN_ID,
        `✅ Nuovo abbonamento!\nUtente: ${
          username ? "@" + username : telegramId
          }`
      );
      
      const invite = await bot.createChatInviteLink(CHANNEL_ID, {
        member_limit: 1,
        name: username ? `user_${username}` :  `user_${telegramId}`,
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
     
      //NOTIFICA ADMIN

      const subscription = event.data.object

      const customer = await stripe.customers.retrieve(subscription.customer);

      const telegramId = Number(customer.metadata?.telegramId);
      const username = customer.metadata?.username || "";  
             
      // INVIO MESSAGGIO
      await bot.sendMessage(
        ADMIN_ID,
        `❌ Abbonamento terminato!
        Utente: ${username ? "@" + username : telegramId}`
      );

      if (!telegramId) { 
           console.log("❌ telegramId NON trovato");
           return; 
      }
      try {          
        await bot.banChatMember(CHANNEL_ID, telegramId);
        await bot.unbanChatMember(CHANNEL_ID, telegramId);

        console.log(`Utente ${telegramId} rimosso dal canale`);
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
