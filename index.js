let isProcessing = false;

bot.on("message", async (msg) => {
  const text = msg.text?.toLowerCase();

  // 👉 risponde SOLO a "ciao"
  if (text !== "ciao") return;

  // 👉 blocca doppie richieste
  if (isProcessing) return;
  isProcessing = true;

  const chatId = msg.chat.id;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price: "price_1TG1UPKSYfmjXmRwCcfunIZp", // il tuo ID
          quantity: 1,
        },
      ],
      success_url: "https://t.me/tuo_bot",
      cancel_url: "https://t.me/tuo_bot",
    });

    await bot.sendMessage(chatId, `🔥 Accedi qui 👇\n${session.url}`);

  } catch (error) {
    console.log("ERRORE STRIPE:", error);
    await bot.sendMessage(chatId, "❌ Errore pagamento, riprova");
  }

  isProcessing = false;
});
