const TelegramBot = require("node-telegram-bot-api");
const Stripe = require("stripe");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price: "price_1TG1UPKSYfmjXmRwCcfunIZp", // tuo vero ID
          quantity: 1,
        },
      ],
      success_url: "https://t.me/tuo_bot",
      cancel_url: "https://t.me/tuo_bot",
    });

    // 👉 manda SOLO il link
    return bot.sendMessage(chatId, `🔥 Accedi qui 👇
    ${session.url}`);
    
  } catch (error) {
    console.log("ERRORE STRIPE:", error);
    return bot.sendMessage(chatId, "❌ Errore pagamento, riprova");
  }
});
