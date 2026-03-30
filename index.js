const TelegramBot = require("node-telegram-bot-api");
const Stripe = require("stripe");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

bot.on("message", async (msg) => {
  const text = msg.text?.toLowerCase();
  const chatId = msg.chat.id;

  // 👉 accetta ciao o /start
  if (!text || (!text.includes("ciao") && text !== "/start")) return;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price: "price_1TG1UPKSYfmjXmRwCcfunIZp", // il tuo ID GIUSTO
          quantity: 1,
        },
      ],
      success_url: "https://t.me/tuo_bot",
      cancel_url: "https://t.me/tuo_bot",
    });

    return bot.sendMessage(chatId, `🔥 Accedi qui 👇\n${session.url}`);

  } catch (error) {
    console.log("ERRORE STRIPE:", error);
    return bot.sendMessage(chatId, "❌ Errore pagamento, riprova");
  }
});
