const utenti = new Set();
const TelegramBot = require("node-telegram-bot-api");
const Stripe = require("stripe");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_ID_5_EURO = "price_1TG1UPKSYfmjXmRwCcfunIZp";
const PRICE_ID_10_EURO = "price_1U8HRWKSYfmjXmRwxjE916lj";

// 1° settembre 2026, ore 00:00 in Italia
const CAMBIO_PREZZO = Date.UTC(2026, 7, 31, 22, 0, 0);


bot.on("message", async (msg) => {
  const text = msg.text?.toLowerCase();
  const chatId = msg.chat.id; 
  const username = msg.from.username || '';
  
  if (utenti.has(chatId)) return;
  utenti.add(chatId);

  setTimeout(() => {
    utenti.delete(chatId);
  }, 5000);

  // 👉 accetta ciao o /start
  if (!text || (!text.includes("ciao") && text !== "/start")) return;

  try {
    const firstName = msg.from.first_name || '';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username || '';

    const fullName = [firstName, lastName]
      .filter(Boolean)
      .join(" ");
    
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
  
      client_reference_id: chatId,
 
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
          price: Date.now() >= CAMBIO_PREZZO ? PRICE_ID_10_EURO : PRICE_ID_5_EURO,
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
