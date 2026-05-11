const express = require("express");
const bodyParser = require("body-parser");
const TelegramBot = require("node-telegram-bot-api");

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(bodyParser.json());

const bot = new TelegramBot(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_ID = 1192463575;

app.post("/webhook", async (req, res) => {
  const event = req.body;

  console.log("EVENT RICEVUTO:", event.type);

  try {
    //PAGAMENTO COMPLETATO
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

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
        `✅ Nuovo abbonamento!\nUtente: ${displayName}`
      );

      //INVITO CANALE
      const invite = await bot.createChatInviteLink(CHANNEL_ID, {
        creates_join_request: true,
        
        expire_date: Math.floor(Date.now() / 1000) + 300,
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
          "✅ Pagamento ricevuto! Entra nel canale:",
          {
            reply_markup: {
              inline_keyboard: [[{ text: "Entra", url: inviteLink }]],
            },
          } 
        );
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
      if ((!telegramId || !username || !name) && subscription.customer) {
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
        `❌ Abbonamento terminato!\nUtente: ${displayName}`
      );

      //RIMOZIONE DAL CANALE
      if (!telegramId) { 
        await bot.banChatMember(CHANNEL_ID, telegramId);
        await bot.unbanChatMember(CHANNEL_ID, telegramId);

        console.log(`Utente ${telegramId} rimosso dal canale`);
      } else {
        console.log("❌ telegramId NON trovato");     
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

