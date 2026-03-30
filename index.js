let isProcessing = false;

bot.on("message", async (msg) => {
  const text = msg.text?.toLowerCase();
  const chatId = msg.chat.id;

  // 👉 accetta sia "ciao" che "/start"
  if (!text || (!text.includes("ciao") && text !== "/start")) return;

  if (isProcessing) return;
  isProcessing = true;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price: "price_1TG1UPKSYfmjXmRwCcfunIZp", // CONTROLLA QUESTO
          quantity: 1,
        },
      ],
      success_url: "https://t.me/tuo_bot",
      cancel_url: "https://t.me/tuo_bot",
    });

    await bot.sendMessage(chatId, `🔥 Accedi qui 👇\n${session.url}`);

  } catch (error) {
    console.log("ERRORE STRIPE:", error);

    // 👇 errore più pulito
    await bot.sendMessage(chatId, "⚠️ Riprova tra qualche secondo");
  }

  isProcessing = false;
});
