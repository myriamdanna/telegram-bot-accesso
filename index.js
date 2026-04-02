const utenti = new Set();
const TelegramBot = require("node-telegram-bot-api");
const Stripe = require("stripe");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

bot.on("message", async (msg) => {
  const text = msg.text?.toLowerCase();
  const chatId = msg.chat.id; 
  
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
      line_items: [
        {
          price: "price_1TG1UPKSYfmjXmRwCcfunIZp",
          quantity: 1,
        },
      ],
      success_url: "https://t.me/google.com",
      cancel_url: "https://t.me/google.com",
    });

    return bot.sendMessage(
      chatId,
      "🔥 Accedi qui 👇\n" + session.url
    );

  } catch (error) {
    console.log("ERRORE STRIPE:", error);
    return bot.sendMessage(chatId, "❌ Errore pagamento, riprova");
  }
});
