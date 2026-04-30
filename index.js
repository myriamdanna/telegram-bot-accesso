const utenti = new Set();
const TelegramBot = require("node-telegram-bot-api");
const Stripe = require("stripe");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
  
      client_reference_id: chatId,

      customer_creation: "always",

      metadata: {
          telegramId: chatId.toString(),
          username: msg.from.username || '',
          name: `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim()
      },

      subscription_data: {
        metadata: {
          telegramId: chatId.toString(),
          username: msg.from.username || '',
          name: `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim()
        }
      },
        
      line_items: [
        {
          price: "price_1TG1UPKSYfmjXmRwCcfunIZp",
          quantity: 1,
        },
      ],
      
      success_url: "https://t.me/Myriambot?start=success",
      cancel_url: "https://t.me/Myriambot?start=cancel",
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
