import TelegramBot from "node-telegram-bot-api";
import Stripe from "stripe";

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
          price: "PRICE_ID", // 🔴 LO SISTEMIAMO TRA 10 SECONDI
          quantity: 1,
        },  
      ],
      success_url: "https://t.me/tuo_bot",
      cancel_url: "https://t.me/tuo_bot",

      metadata: {
        telegram_id: chatId.toString(),
      },
    });

    bot.sendMessage(
      chatId,
      "🔥 Accedi al contenuto premium qui:\n" + session.url
    );
  } catch (error) {
    console.log(error);
    bot.sendMessage(chatId, "❌ Errore, riprova.");
  }
});
